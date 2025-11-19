import { createClient } from '@supabase/supabase-js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { RekognitionClient, CompareFacesCommand, DetectFacesCommand } from '@aws-sdk/client-rekognition';
import { TextractClient, AnalyzeDocumentCommand } from '@aws-sdk/client-textract';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const s3 = new S3Client({ region: process.env.AWS_REGION });
const rekognition = new RekognitionClient({ region: process.env.AWS_REGION });
const textract = new TextractClient({ region: process.env.AWS_REGION });

const BUCKET = process.env.S3_BUCKET_NAME;

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  // Handle OPTIONS request
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action } = req.body;

  try {
    if (action === 'start') {
      const token = Math.random().toString(36).substring(2, 15);
      
      const { data } = await supabase
        .from('demo_sessions')
        .insert({ session_token: token })
        .select()
        .single();
      
      return res.json({ 
        session_token: token,
        verify_url: `/verify/${token}` 
      });
    }

    if (action === 'upload_document') {
      const { session_token, image_base64, guest_name, room_number } = req.body;
      
      const imageBuffer = Buffer.from(image_base64, 'base64');
      
      const s3Key = `demo/${session_token}/document.jpg`;
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: s3Key,
        Body: imageBuffer,
        ContentType: 'image/jpeg'
      }));
      
      const documentUrl = `https://${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;
      
      const textractResult = await textract.send(new AnalyzeDocumentCommand({
        Document: { Bytes: imageBuffer },
        FeatureTypes: ['FORMS']
      }));
      
      const extractedText = textractResult.Blocks
        ?.filter(b => b.BlockType === 'LINE')
        .map(b => b.Text)
        .join(' ') || '';
      
      await supabase
        .from('demo_sessions')
        .update({
          status: 'document_uploaded',
          document_url: documentUrl,
          guest_name,
          room_number,
          extracted_info: { text: extractedText }
        })
        .eq('session_token', session_token);
      
      await supabase.from('demo_api_costs').insert({
        session_id: session_token,
        operation: 'textract',
        cost_usd: 0.05
      });
      
      return res.json({ 
        success: true,
        extracted_text: extractedText.substring(0, 200)
      });
    }

    if (action === 'verify_face') {
      const { session_token, selfie_base64 } = req.body;
      
      const { data: session } = await supabase
        .from('demo_sessions')
        .select('*')
        .eq('session_token', session_token)
        .single();
      
      if (!session?.document_url) {
        return res.status(400).json({ error: 'Document not uploaded' });
      }
      
      const selfieBuffer = Buffer.from(selfie_base64, 'base64');
      
      const selfieKey = `demo/${session_token}/selfie.jpg`;
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: selfieKey,
        Body: selfieBuffer,
        ContentType: 'image/jpeg'
      }));
      
      const selfieUrl = `https://${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${selfieKey}`;
      
      const livenessResult = await rekognition.send(new DetectFacesCommand({
        Image: { Bytes: selfieBuffer },
        Attributes: ['ALL']
      }));
      
      const face = livenessResult.FaceDetails?.[0];
      const isLive = face?.EyesOpen?.Value && face?.Quality?.Brightness > 40;
      const livenessScore = (face?.Confidence || 0) / 100;
      
      const docResponse = await fetch(session.document_url);
      const docBuffer = Buffer.from(await docResponse.arrayBuffer());
      
      const compareResult = await rekognition.send(new CompareFacesCommand({
        SourceImage: { Bytes: selfieBuffer },
        TargetImage: { Bytes: docBuffer },
        SimilarityThreshold: 80
      }));
      
      const similarity = (compareResult.FaceMatches?.[0]?.Similarity || 0) / 100;
      
      const verificationScore = (isLive ? 0.4 : 0) + (livenessScore * 0.3) + (similarity * 0.3);
      const isVerified = isLive && similarity >= 0.85;
      
      await supabase
        .from('demo_sessions')
        .update({
          status: isVerified ? 'verified' : 'failed',
          selfie_url: selfieUrl,
          is_verified: isVerified,
          verification_score: verificationScore
        })
        .eq('session_token', session_token);
      
      await supabase.from('demo_api_costs').insert([
        { session_id: session_token, operation: 'liveness', cost_usd: 0.001 },
        { session_id: session_token, operation: 'face_compare', cost_usd: 0.001 }
      ]);
      
      await supabase.rpc('increment_demo_stats', {
        verified: isVerified,
        cost: 0.052
      });
      
      return res.json({
        success: true,
        is_verified: isVerified,
        verification_score: verificationScore,
        details: {
          liveness_passed: isLive,
          liveness_score: livenessScore,
          face_match_score: similarity
        }
      });
    }

    return res.status(400).json({ error: 'Invalid action' });
    
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
