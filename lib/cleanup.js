import { createClient } from '@supabase/supabase-js';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET = process.env.S3_BUCKET_NAME;

export async function deleteOldSessionsAndImages() {
  const cutoffDate = new Date();
  cutoffDate.setHours(cutoffDate.getHours() - 72); // 72 hours ago
  const cutoffTimestamp = cutoffDate.toISOString();
  
  console.log('Starting cleanup for sessions older than:', cutoffTimestamp);
  
  let deletedSessions = 0;
  let deletedImages = 0;
  const errors = [];
  
  try {
    // Find all old sessions
    const { data: oldSessions, error: fetchError } = await supabase
      .from('demo_sessions')
      .select('*')
      .lt('created_at', cutoffTimestamp);
    
    if (fetchError) {
      throw new Error(`Failed to fetch old sessions: ${fetchError.message}`);
    }
    
    if (!oldSessions || oldSessions.length === 0) {
      console.log('No sessions to clean up');
      return {
        success: true,
        deletedSessions: 0,
        deletedImages: 0,
        cutoffTimestamp
      };
    }
    
    console.log(`Found ${oldSessions.length} sessions to delete`);
    
    // Process each session
    for (const session of oldSessions) {
      try {
        // Extract S3 keys from URLs
        const imagesToDelete = [];
        
        if (session.document_url) {
          // URL format: https://s3.ap-southeast-2.amazonaws.com/hotel-verify-demo-123/demo/token/document.jpg
          const docKey = session.document_url.split(`${BUCKET}/`)[1];
          if (docKey) imagesToDelete.push(docKey);
        }
        
        if (session.selfie_url) {
          const selfieKey = session.selfie_url.split(`${BUCKET}/`)[1];
          if (selfieKey) imagesToDelete.push(selfieKey);
        }
        
        // Delete images from S3
        for (const key of imagesToDelete) {
          try {
            await s3.send(new DeleteObjectCommand({
              Bucket: BUCKET,
              Key: key
            }));
            deletedImages++;
            console.log(`Deleted S3 object: ${key}`);
          } catch (s3Error) {
            console.error(`Failed to delete S3 object ${key}:`, s3Error.message);
            errors.push(`S3: ${key} - ${s3Error.message}`);
            // Continue even if S3 deletion fails
          }
        }
        
        // Delete related API costs
        const { error: costError } = await supabase
          .from('demo_api_costs')
          .delete()
          .eq('session_id', session.session_token);
        
        if (costError) {
          console.error(`Failed to delete costs for session ${session.session_token}:`, costError.message);
        }
        
        // Delete the session
        const { error: deleteError } = await supabase
          .from('demo_sessions')
          .delete()
          .eq('session_token', session.session_token);
        
        if (deleteError) {
          console.error(`Failed to delete session ${session.session_token}:`, deleteError.message);
          errors.push(`Session: ${session.session_token} - ${deleteError.message}`);
        } else {
          deletedSessions++;
          console.log(`Deleted session: ${session.session_token}`);
        }
        
      } catch (sessionError) {
        console.error(`Error processing session ${session.session_token}:`, sessionError.message);
        errors.push(`Session processing: ${session.session_token} - ${sessionError.message}`);
      }
    }
    
    console.log(`Cleanup complete: ${deletedSessions} sessions, ${deletedImages} images deleted`);
    if (errors.length > 0) {
      console.log(`Encountered ${errors.length} errors during cleanup`);
    }
    
    return {
      success: true,
      deletedSessions,
      deletedImages,
      cutoffTimestamp,
      errors: errors.length > 0 ? errors : undefined
    };
    
  } catch (error) {
    console.error('Cleanup failed:', error);
    return {
      success: false,
      error: error.message,
      deletedSessions,
      deletedImages,
      cutoffTimestamp
    };
  }
}
