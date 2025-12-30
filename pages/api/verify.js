import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import {
  RekognitionClient,
  CompareFacesCommand,
  DetectFacesCommand,
} from "@aws-sdk/client-rekognition";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const AWS_REGION = process.env.AWS_REGION;
const BUCKET = process.env.S3_BUCKET_NAME;

if (!SUPABASE_URL) console.warn("Missing env: NEXT_PUBLIC_SUPABASE_URL");
if (!SUPABASE_SERVICE_KEY) console.warn("Missing env: SUPABASE_SERVICE_KEY");
if (!AWS_REGION) console.warn("Missing env: AWS_REGION");
if (!BUCKET) console.warn("Missing env: S3_BUCKET_NAME");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const s3 = new S3Client({ region: AWS_REGION });
const rekognition = new RekognitionClient({ region: AWS_REGION });

function setCors(res) {
  // If you want to lock this down later, replace '*' with your Lovable domain.
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,OPTIONS,PATCH,DELETE,POST,PUT"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );
}

function generateToken() {
  // 12 chars, URL-safe-ish
  return crypto.randomBytes(9).toString("base64url");
}

async function streamToBuffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function stripDataUrlPrefix(base64OrDataUrl) {
  if (typeof base64OrDataUrl !== "string") return null;
  return base64OrDataUrl.replace(/^data:image\/\w+;base64,/, "");
}

function inferStepFromSession(session) {
  // If you add explicit step tracking later, this is your fallback inference.
  if (session?.is_verified === true || session?.verification_score != null) return "results";
  if (session?.selfie_url) return "results"; // already did selfie step
  if (session?.document_url) return "selfie";
  if (session?.guest_name || session?.room_number) return "document";
  return "welcome";
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  // Keep POST-only for now to match your frontend
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { action } = req.body || {};

  try {
    // Basic env sanity check
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(500).json({
        error: "Server misconfigured: missing Supabase env vars",
      });
    }

    // ---------------------------
    // ACTION: start
    // ---------------------------
    if (action === "start") {
      const token = generateToken();

      const { error } = await supabase
        .from("demo_sessions")
        .insert({
          session_token: token,
          status: "started",
          current_step: "welcome",
        });

      if (error) {
        console.error("Error creating session:", error);
        return res.status(500).json({ error: "Failed to create session" });
      }

      return res.json({
        session_token: token,
        verify_url: `/verify/${token}`,
      });
    }

    // ---------------------------
    // ACTION: get_session (NEW)
    // used for "resume after refresh"
    // ---------------------------
    if (action === "get_session") {
      const { session_token } = req.body || {};

      if (!session_token) {
        return res.status(400).json({ error: "Session token required" });
      }

      const { data: session, error } = await supabase
        .from("demo_sessions")
        .select(
          [
            "session_token",
            "status",
            "current_step",
            "consent_given",
            "consent_time",
            "consent_locale",
            "guest_name",
            "room_number",
            "document_url",
            "selfie_url",
            "is_verified",
            "verification_score",
            "extracted_info",
            "created_at",
            "updated_at",
          ].join(",")
        )
        .eq("session_token", session_token)
        .single();

      if (error || !session) {
        return res.status(404).json({ error: "Session not found" });
      }

      const current_step = session.current_step || inferStepFromSession(session);

      return res.json({
        success: true,
        session: {
          session_token: session.session_token,
          consent_given: session.consent_given ?? null,
          consent_time: session.consent_time ?? null,
          consent_locale: session.consent_locale ?? null,
          guest_name: session.guest_name ?? null,
          room_number: session.room_number ?? null,
          document_uploaded: Boolean(session.document_url),
          selfie_uploaded: Boolean(session.selfie_url),
          is_verified: session.is_verified ?? null,
          verification_score: session.verification_score ?? null,
          current_step,
          status: session.status ?? null,
        },
      });
    }

    // ---------------------------
    // ACTION: log_consent
    // ---------------------------
    if (action === "log_consent") {
      const { session_token, consent_given, consent_time, consent_locale } =
        req.body || {};

      if (!session_token) {
        return res.status(400).json({ error: "Session token required" });
      }

      // Ensure session exists
      const { data: existing, error: findError } = await supabase
        .from("demo_sessions")
        .select("session_token")
        .eq("session_token", session_token)
        .single();

      if (findError || !existing) {
        return res.status(404).json({ error: "Session not found" });
      }

      const { error: updateError } = await supabase
        .from("demo_sessions")
        .update({
          consent_given: Boolean(consent_given),
          consent_time: consent_time || new Date().toISOString(),
          consent_locale: consent_locale || "en",
          status: "consent_logged",
          current_step: "welcome",
          updated_at: new Date().toISOString(),
        })
        .eq("session_token", session_token);

      if (updateError) {
        console.error("Error updating consent:", updateError);
        return res.status(500).json({ error: "Failed to log consent" });
      }

      return res.json({
        success: true,
        message: "Consent logged successfully",
      });
    }

    // ---------------------------
    // ACTION: upload_document
    // ---------------------------
    if (action === "upload_document") {
      const { session_token, image_data, guest_name, room_number } = req.body || {};

      if (!session_token) return res.status(400).json({ error: "Session token required" });
      if (!image_data) return res.status(400).json({ error: "image_data required" });

      if (!AWS_REGION || !BUCKET) {
        return res.status(500).json({ error: "Server misconfigured: missing AWS env vars" });
      }

      const base64Data = stripDataUrlPrefix(image_data);
      if (!base64Data) return res.status(400).json({ error: "Invalid image_data format" });

      const imageBuffer = Buffer.from(base64Data, "base64");
      if (imageBuffer.length < 1000) {
        return res.status(400).json({ error: "Image too small" });
      }

      const s3Key = `demo/${session_token}/document.jpg`;

      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: s3Key,
          Body: imageBuffer,
          ContentType: "image/jpeg",
        })
      );

      // Store a private S3 "pointer" (key) + keep URL for convenience if you want
      const documentUrl = `s3://${BUCKET}/${s3Key}`;

      // (Optional) placeholder until Textract is wired
      const extractedText = "Text extraction disabled (pending AWS activation)";

      const { error: updateError } = await supabase
        .from("demo_sessions")
        .update({
          status: "document_uploaded",
          current_step: "selfie",
          document_url: documentUrl,
          guest_name: guest_name || null,
          room_number: room_number || null,
          extracted_info: { text: extractedText },
          updated_at: new Date().toISOString(),
        })
        .eq("session_token", session_token);

      if (updateError) {
        console.error("Error updating document session:", updateError);
        return res.status(500).json({ error: "Failed to save document state" });
      }

      return res.json({
        success: true,
        extracted_text: extractedText.substring(0, 200),
      });
    }

    // ---------------------------
    // ACTION: verify_face
    // ---------------------------
    if (action === "verify_face") {
      const { session_token, selfie_data } = req.body || {};

      if (!session_token) return res.status(400).json({ error: "Session token required" });
      if (!selfie_data) return res.status(400).json({ error: "selfie_data required" });

      if (!AWS_REGION || !BUCKET) {
        return res.status(500).json({ error: "Server misconfigured: missing AWS env vars" });
      }

      const { data: session, error: sessionError } = await supabase
        .from("demo_sessions")
        .select("*")
        .eq("session_token", session_token)
        .single();

      if (sessionError || !session) {
        return res.status(404).json({ error: "Session not found" });
      }

      if (!session?.document_url) {
        return res.status(400).json({ error: "Document not uploaded" });
      }

      const selfieBase64 = stripDataUrlPrefix(selfie_data);
      if (!selfieBase64) return res.status(400).json({ error: "Invalid selfie_data format" });

      const selfieBuffer = Buffer.from(selfieBase64, "base64");
      if (selfieBuffer.length < 1000) {
        return res.status(400).json({ error: "Image too small" });
      }

      const selfieKey = `demo/${session_token}/selfie.jpg`;
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: selfieKey,
          Body: selfieBuffer,
          ContentType: "image/jpeg",
        })
      );

      const selfieUrl = `s3://${BUCKET}/${selfieKey}`;

      // Liveness-ish heuristic (not true liveness, but your existing logic)
      const livenessResult = await rekognition.send(
        new DetectFacesCommand({
          Image: { Bytes: selfieBuffer },
          Attributes: ["ALL"],
        })
      );

      const face = livenessResult.FaceDetails?.[0];
      const isLive = Boolean(face?.EyesOpen?.Value) && (face?.Quality?.Brightness || 0) > 40;
      const livenessScore = (face?.Confidence || 0) / 100;

      // Load the document from S3 using GetObject (works for private buckets)
      // document_url stored as s3://bucket/key
      const docUrl = String(session.document_url);
      const match = docUrl.match(/^s3:\/\/([^/]+)\/(.+)$/);

      if (!match) {
        return res.status(500).json({ error: "Invalid document_url format in session" });
      }

      const [, docBucket, docKey] = match;

      const docObj = await s3.send(
        new GetObjectCommand({
          Bucket: docBucket,
          Key: docKey,
        })
      );

      const docStream = docObj.Body;
      if (!docStream) {
        return res.status(500).json({ error: "Failed to read document from S3" });
      }

      const docBuffer = await streamToBuffer(docStream);

      const compareResult = await rekognition.send(
        new CompareFacesCommand({
          SourceImage: { Bytes: selfieBuffer },
          TargetImage: { Bytes: docBuffer },
          SimilarityThreshold: 80,
        })
      );

      const similarity = (compareResult.FaceMatches?.[0]?.Similarity || 0) / 100;

      const verificationScore =
        (isLive ? 0.4 : 0) + livenessScore * 0.3 + similarity * 0.3;

      const isVerified = isLive && similarity >= 0.75;

      const { error: updateError } = await supabase
        .from("demo_sessions")
        .update({
          status: isVerified ? "verified" : "failed",
          current_step: "results",
          selfie_url: selfieUrl,
          is_verified: isVerified,
          verification_score: verificationScore,
          liveness_score: livenessScore,
          face_match_score: similarity,
          updated_at: new Date().toISOString(),
        })
        .eq("session_token", session_token);

      if (updateError) {
        console.error("Error updating verification session:", updateError);
        return res.status(500).json({ error: "Failed to save verification result" });
      }

      // Optional: costs + stats (keep your existing behavior)
      await supabase.from("demo_api_costs").insert([
        { session_id: session_token, operation: "liveness", cost_usd: 0.001 },
        { session_id: session_token, operation: "face_compare", cost_usd: 0.001 },
      ]);

      await supabase.rpc("increment_demo_stats", {
        verified: isVerified,
        cost: 0.052,
      });

      // Frontend-friendly shape (matches your Vite client expectations)
      return res.json({
        success: true,
        is_verified: isVerified,
        data: {
          liveness_score: livenessScore,
          face_match_score: similarity,
          verification_score: verificationScore,
          is_verified: isVerified,
        },
      });
    }

    return res.status(400).json({ error: "Invalid action" });
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({
      error: error?.message || "Unknown server error",
    });
  }
}
