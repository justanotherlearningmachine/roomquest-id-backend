import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  RekognitionClient,
  CompareFacesCommand,
  DetectFacesCommand,
} from "@aws-sdk/client-rekognition";
import { TextractClient, AnalyzeIDCommand } from "@aws-sdk/client-textract";

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
const textract = new TextractClient({ region: AWS_REGION });

function setCors(res) {
  // For production harden: replace '*' with https://quest-id-flow.lovable.app
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version"
  );
}

function generateToken() {
  // URL-safe session token
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
  if (!session) return "welcome";
  if (session?.current_step) return session.current_step;

  // Fallback inference if current_step wasn't stored
  if (session?.is_verified === true || session?.verification_score != null) return "results";
  if (session?.selfie_url) return "results";
  if (session?.document_url) return "selfie";
  if (session?.guest_name || session?.room_number) return "document";
  return "welcome";
}

function parseS3Url(s3Url) {
  // expects: s3://bucket/key
  const match = String(s3Url || "").match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { bucket: match[1], key: match[2] };
}

function normalizeKey(k = "") {
  return String(k).trim().toLowerCase().replace(/\s+/g, "_");
}

function parseAnalyzeIdFields(fields = []) {
  const raw = {};
  for (const f of fields) {
    const key = normalizeKey(f?.Type?.Text);
    const val = f?.ValueDetection?.Text;
    if (key && val) raw[key] = val;
  }

  // Best-effort normalization (fields vary by document type/country)
  const fullName =
    raw.name ||
    raw.full_name ||
    raw.given_name && raw.surname
      ? [raw.given_name, raw.surname].filter(Boolean).join(" ")
      : null;

  const dob = raw.date_of_birth || raw.dob || null;
  const nationality = raw.nationality || raw.country || null;

  // Document number can show up under multiple names
  const documentNumber =
    raw.document_number ||
    raw.passport_number ||
    raw.id_number ||
    raw.identity_document_number ||
    raw.personal_number ||
    null;

  return {
    full_name: fullName || null,
    nationality,
    dob,
    document_number: documentNumber,
    raw,
  };
}

async function runTextractAnalyzeIdNonBlocking(imageBuffer) {
  // Non-blocking helper: returns { ok, data?, error? }
  try {
    const res = await textract.send(
      new AnalyzeIDCommand({
        DocumentPages: [{ Bytes: imageBuffer }],
      })
    );

    const fields =
      res?.IdentityDocuments?.[0]?.IdentityDocumentFields || [];

    const parsed = parseAnalyzeIdFields(fields);

    return { ok: true, data: parsed };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

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

      const { error } = await supabase.from("demo_sessions").insert({
        session_token: token,
        status: "started",
        current_step: "welcome",
        updated_at: new Date().toISOString(),
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
    // ACTION: get_session
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
            "liveness_score",
            "face_match_score",
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

      const current_step = inferStepFromSession(session);

      return res.json({
        success: true,
        session: {
          session_token: session.session_token,
          status: session.status ?? null,
          current_step,
          consent_given: session.consent_given ?? null,
          consent_time: session.consent_time ?? null,
          consent_locale: session.consent_locale ?? null,
          guest_name: session.guest_name ?? null,
          room_number: session.room_number ?? null,
          document_uploaded: Boolean(session.document_url),
          selfie_uploaded: Boolean(session.selfie_url),
          is_verified: session.is_verified ?? null,
          verification_score: session.verification_score ?? null,
          liveness_score: session.liveness_score ?? null,
          face_match_score: session.face_match_score ?? null,
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
    // ACTION: update_guest (NEW)
    // Step 1 persistence: lets refresh resume at Document step
    // ---------------------------
    if (action === "update_guest") {
      const { session_token, guest_name, booking_ref, room_number } = req.body || {};

      if (!session_token) {
        return res.status(400).json({ error: "Session token required" });
      }

      // Accept either booking_ref or room_number (frontends vary)
      const bookingValue = booking_ref || room_number || null;

      const { error: updateError } = await supabase
        .from("demo_sessions")
        .update({
          guest_name: guest_name || null,
          room_number: bookingValue, // treat this as "booking ref" for now
          status: "guest_info_saved",
          current_step: "document",
          updated_at: new Date().toISOString(),
        })
        .eq("session_token", session_token);

      if (updateError) {
        console.error("Error saving guest info:", updateError);
        return res.status(500).json({ error: "Failed to save guest info" });
      }

      return res.json({ success: true });
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

      // Store as private pointer
      const documentUrl = `s3://${BUCKET}/${s3Key}`;

      // ---- Textract (AnalyzeID) - BACKEND ONLY, NON-BLOCKING ----
      // If Textract fails, we still proceed with the flow.
      const textractResult = await runTextractAnalyzeIdNonBlocking(imageBuffer);

      // Keep a friendly message for compatibility with your existing frontend.
      // (Frontend doesn't need to display this; it's just here if you want.)
      let extractedText = "Text extraction unavailable";
      let extractedStructured = null;

      if (textractResult.ok) {
        extractedStructured = textractResult.data;
        extractedText = [
          extractedStructured.full_name ? `Name: ${extractedStructured.full_name}` : null,
          extractedStructured.nationality ? `Nationality: ${extractedStructured.nationality}` : null,
          extractedStructured.dob ? `DOB: ${extractedStructured.dob}` : null,
          extractedStructured.document_number ? `Doc#: ${extractedStructured.document_number}` : null,
        ]
          .filter(Boolean)
          .join(" | ") || "Textract extracted fields (see extracted_info.textract)";
      } else {
        extractedText = "Textract failed (non-blocking)";
        console.warn("Textract AnalyzeID failed (non-blocking):", textractResult.error);
      }

      const { error: updateError } = await supabase
        .from("demo_sessions")
        .update({
          status: "document_uploaded",
          current_step: "selfie",
          document_url: documentUrl,
          guest_name: guest_name || null,
          room_number: room_number || null,
          extracted_info: {
            text: extractedText,
            textract: extractedStructured,
            textract_ok: textractResult.ok,
            textract_error: textractResult.ok ? null : textractResult.error,
          },
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
        // Optional: include structured data (frontend can ignore)
        data: extractedStructured
          ? { extracted_text: extractedText, extracted_fields: extractedStructured }
          : { extracted_text: extractedText },
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

      // Heuristic "liveness" (not true liveness)
      const livenessResult = await rekognition.send(
        new DetectFacesCommand({
          Image: { Bytes: selfieBuffer },
          Attributes: ["ALL"],
        })
      );

      const face = livenessResult.FaceDetails?.[0];
      const isLive = Boolean(face?.EyesOpen?.Value) && (face?.Quality?.Brightness || 0) > 40;
      const livenessScore = (face?.Confidence || 0) / 100;

      // Load the document from private S3
      const parsed = parseS3Url(session.document_url);
      if (!parsed) {
        return res.status(500).json({ error: "Invalid document_url format in session" });
      }

      const docObj = await s3.send(
        new GetObjectCommand({
          Bucket: parsed.bucket,
          Key: parsed.key,
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

      const isVerified = isLive && similarity >= 0.65;

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

      // Optional: costs + stats (safe to ignore failures, but keep behavior)
      try {
        await supabase.from("demo_api_costs").insert([
          { session_id: session_token, operation: "liveness", cost_usd: 0.001 },
          { session_id: session_token, operation: "face_compare", cost_usd: 0.001 },
        ]);
      } catch (e) {
        console.warn("Cost insert failed (non-blocking):", e?.message || e);
      }

      try {
        await supabase.rpc("increment_demo_stats", {
          verified: isVerified,
          cost: 0.052,
        });
      } catch (e) {
        console.warn("increment_demo_stats failed (non-blocking):", e?.message || e);
      }

      // Frontend-friendly shape
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
