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
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version"
  );
}

function generateToken() {
  return crypto.randomBytes(9).toString("base64url");
}

async function streamToBuffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function normalizeBase64(base64OrDataUrl) {
  if (typeof base64OrDataUrl !== "string") return null;
  if (base64OrDataUrl.startsWith("data:image/")) {
    return base64OrDataUrl.replace(/^data:image\/\w+;base64,/, "");
  }
  return base64OrDataUrl;
}

function inferStepFromSession(session) {
  if (!session) return "welcome";
  if (session?.current_step) return session.current_step;

  if (session?.is_verified === true || session?.verification_score != null) return "results";
  if (session?.selfie_url) return "results";
  if (session?.document_url) return "selfie";
  if (session?.guest_name || session?.room_number) return "document";
  return "welcome";
}

function parseS3Url(s3Url) {
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

  const given = raw.given_name || raw.firstname || raw.first_name || null;
  const sur = raw.surname || raw.lastname || raw.last_name || null;

  const full_name =
    raw.full_name ||
    raw.name ||
    (given || sur ? [given, sur].filter(Boolean).join(" ") : null) ||
    null;

  const dob = raw.date_of_birth || raw.dob || null;
  const nationality = raw.nationality || raw.country || null;

  const document_number =
    raw.document_number ||
    raw.passport_number ||
    raw.id_number ||
    raw.identity_document_number ||
    raw.personal_number ||
    null;

  return {
    full_name,
    nationality,
    dob,
    document_number,
    raw,
  };
}

async function runTextractAnalyzeIdWithTimeout(imageBuffer, timeoutMs = 15000) {
  const run = async () => {
    const res = await textract.send(
      new AnalyzeIDCommand({
        DocumentPages: [{ Bytes: imageBuffer }],
      })
    );
    const fields = res?.IdentityDocuments?.[0]?.IdentityDocumentFields || [];
    return parseAnalyzeIdFields(fields);
  };

  try {
    const data = await Promise.race([
      run(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Textract timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function toIntOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function clampInt(n, min, max) {
  const x = toIntOrNull(n);
  if (x === null) return min;
  return Math.min(Math.max(x, min), max);
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
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: "Server misconfigured: missing Supabase env vars" });
    }

    if (action === "start") {
      const token = generateToken();
      const expected_guest_count = 1;
      const verified_guest_count = 0;
      const requires_additional_guest = expected_guest_count > verified_guest_count;

      const { error } = await supabase.from("demo_sessions").insert({
        session_token: token,
        status: "started",
        current_step: "welcome",
        expected_guest_count,
        verified_guest_count,
        requires_additional_guest,
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

    if (action === "get_session") {
      const { session_token } = req.body || {};
      if (!session_token) return res.status(400).json({ error: "Session token required" });

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
            "expected_guest_count",
            "verified_guest_count",
            "requires_additional_guest",
            "created_at",
            "updated_at",
          ].join(",")
        )
        .eq("session_token", session_token)
        .single();

      if (error || !session) return res.status(404).json({ error: "Session not found" });

      const current_step = inferStepFromSession(session);
      const expected = clampInt(session.expected_guest_count, 1, 10);
      const verified = clampInt(session.verified_guest_count, 0, 10);

      const requires =
        session.requires_additional_guest === true
          ? true
          : session.requires_additional_guest === false
          ? false
          : verified < expected;

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

          extracted_info: session.extracted_info ?? null,

          expected_guest_count: expected,
          verified_guest_count: verified,
          requires_additional_guest: requires,
          remaining_guest_verifications: Math.max(expected - verified, 0),
        },
      });
    }

    if (action === "log_consent") {
      const { session_token, consent_given, consent_time, consent_locale } = req.body || {};
      if (!session_token) return res.status(400).json({ error: "Session token required" });

      const { data: existing, error: findError } = await supabase
        .from("demo_sessions")
        .select("session_token")
        .eq("session_token", session_token)
        .single();

      if (findError || !existing) return res.status(404).json({ error: "Session not found" });

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

      return res.json({ success: true, message: "Consent logged successfully" });
    }

    if (action === "update_guest") {
      const { session_token, guest_name, booking_ref, room_number, expected_guest_count } = req.body || {};
      if (!session_token) return res.status(400).json({ error: "Session token required" });

      const bookingValue = booking_ref || room_number || null;
      const expectedOverride = toIntOrNull(expected_guest_count);
      const expectedToSet = expectedOverride === null ? undefined : clampInt(expectedOverride, 1, 10);

      const updatePayload = {
        guest_name: guest_name || null,
        room_number: bookingValue,
        status: "guest_info_saved",
        current_step: "document",
        updated_at: new Date().toISOString(),
      };

      if (expectedToSet !== undefined) {
        updatePayload.expected_guest_count = expectedToSet;

        const { data: s, error: sErr } = await supabase
          .from("demo_sessions")
          .select("verified_guest_count")
          .eq("session_token", session_token)
          .single();

        if (!sErr && s) {
          const verified = clampInt(s.verified_guest_count, 0, 10);
          updatePayload.requires_additional_guest = verified < expectedToSet;
        }
      }

      const { error: updateError } = await supabase
        .from("demo_sessions")
        .update(updatePayload)
        .eq("session_token", session_token);

      if (updateError) {
        console.error("Error saving guest info:", updateError);
        return res.status(500).json({ error: "Failed to save guest info" });
      }

      return res.json({ success: true });
    }

    if (action === "upload_document") {
      const { session_token, image_data, guest_name, room_number } = req.body || {};

      if (!session_token) return res.status(400).json({ error: "Session token required" });
      if (!image_data) return res.status(400).json({ error: "image_data required" });
      if (!AWS_REGION || !BUCKET) return res.status(500).json({ error: "Server misconfigured: missing AWS env vars" });

      const base64Data = normalizeBase64(image_data);
      if (!base64Data) return res.status(400).json({ error: "Invalid image_data format" });

      const imageBuffer = Buffer.from(base64Data, "base64");
      if (imageBuffer.length < 1000) return res.status(400).json({ error: "Image too small" });

      const s3Key = `demo/${session_token}/document.jpg`;

      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: s3Key,
          Body: imageBuffer,
          ContentType: "image/jpeg",
        })
      );

      const documentUrl = `s3://${BUCKET}/${s3Key}`;

      const { error: updateError } = await supabase
        .from("demo_sessions")
        .update({
          status: "document_uploaded",
          current_step: "selfie",
          document_url: documentUrl,
          guest_name: guest_name || null,
          room_number: room_number || null,
          extracted_info: {
            text: "Textract pending (async)",
            textract_ok: null,
            textract_error: null,
            textract: null,
          },
          updated_at: new Date().toISOString(),
        })
        .eq("session_token", session_token);

      if (updateError) {
        console.error("Error updating document session:", updateError);
        return res.status(500).json({ error: "Failed to save document state" });
      }

      runTextractAnalyzeIdWithTimeout(imageBuffer, 15000)
        .then(async (result) => {
          if (result.ok) {
            const extracted = result.data;
            const extractedText =
              [
                extracted.full_name ? `Name: ${extracted.full_name}` : null,
                extracted.nationality ? `Nationality: ${extracted.nationality}` : null,
                extracted.dob ? `DOB: ${extracted.dob}` : null,
                extracted.document_number ? `Doc#: ${extracted.document_number}` : null,
              ]
                .filter(Boolean)
                .join(" | ") || "Textract extracted fields";

            await supabase
              .from("demo_sessions")
              .update({
                extracted_info: {
                  text: extractedText,
                  textract_ok: true,
                  textract_error: null,
                  textract: extracted,
                },
                updated_at: new Date().toISOString(),
              })
              .eq("session_token", session_token);
          } else {
            await supabase
              .from("demo_sessions")
              .update({
                extracted_info: {
                  text: "Textract failed (async)",
                  textract_ok: false,
                  textract_error: result.error,
                  textract: null,
                },
                updated_at: new Date().toISOString(),
              })
              .eq("session_token", session_token);
          }
        })
        .catch((e) => {
          console.warn("Textract async crash:", e?.message || e);
        });

      return res.json({
        success: true,
        extracted_text: "Textract pending (async)",
        data: { extracted_text: "Textract pending (async)" },
      });
    }

    if (action === "verify_face") {
      const { session_token, selfie_data } = req.body || {};

      if (!session_token) return res.status(400).json({ error: "Session token required" });
      if (!selfie_data) return res.status(400).json({ error: "selfie_data required" });
      if (!AWS_REGION || !BUCKET) return res.status(500).json({ error: "Server misconfigured: missing AWS env vars" });

      const { data: session, error: sessionError } = await supabase
        .from("demo_sessions")
        .select("*")
        .eq("session_token", session_token)
        .single();

      if (sessionError || !session) return res.status(404).json({ error: "Session not found" });
      if (!session?.document_url) return res.status(400).json({ error: "Document not uploaded" });

      const selfieBase64 = normalizeBase64(selfie_data);
      if (!selfieBase64) return res.status(400).json({ error: "Invalid selfie_data format" });

      const selfieBuffer = Buffer.from(selfieBase64, "base64");
      if (selfieBuffer.length < 1000) return res.status(400).json({ error: "Image too small" });

      const expected = clampInt(session.expected_guest_count, 1, 10);
      const verifiedBefore = clampInt(session.verified_guest_count, 0, 10);

      const selfieIndex = Math.min(verifiedBefore + 1, 10);
      const selfieKey = `demo/${session_token}/selfie_${selfieIndex}.jpg`;

      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: selfieKey,
          Body: selfieBuffer,
          ContentType: "image/jpeg",
        })
      );

      const selfieUrl = `s3://${BUCKET}/${selfieKey}`;

      const livenessResult = await rekognition.send(
        new DetectFacesCommand({
          Image: { Bytes: selfieBuffer },
          Attributes: ["ALL"],
        })
      );

      const face = livenessResult.FaceDetails?.[0];
      const isLive = Boolean(face?.EyesOpen?.Value) && (face?.Quality?.Brightness || 0) > 40;
      const livenessScore = (face?.Confidence || 0) / 100;

      const parsed = parseS3Url(session.document_url);
      if (!parsed) return res.status(500).json({ error: "Invalid document_url format in session" });

      const docObj = await s3.send(
        new GetObjectCommand({
          Bucket: parsed.bucket,
          Key: parsed.key,
        })
      );

      const docStream = docObj.Body;
      if (!docStream) return res.status(500).json({ error: "Failed to read document from S3" });

      const docBuffer = await streamToBuffer(docStream);

      const compareResult = await rekognition.send(
        new CompareFacesCommand({
          SourceImage: { Bytes: selfieBuffer },
          TargetImage: { Bytes: docBuffer },
          SimilarityThreshold: 80,
        })
      );

      const similarity = (compareResult.FaceMatches?.[0]?.Similarity || 0) / 100;

      const verificationScore = (isLive ? 0.4 : 0) + livenessScore * 0.3 + similarity * 0.3;
      const isVerified = isLive && similarity >= 0.65;

      let verifiedAfter = verifiedBefore;
      if (isVerified) verifiedAfter = Math.min(verifiedBefore + 1, expected);

      const requiresAdditionalGuest = verifiedAfter < expected;

      let statusToSet = "failed";
      if (isVerified && requiresAdditionalGuest) statusToSet = "partial_verified";
      if (isVerified && !requiresAdditionalGuest) statusToSet = "verified";

      const overallVerified = isVerified && !requiresAdditionalGuest;

      const { error: updateError } = await supabase
        .from("demo_sessions")
        .update({
          status: statusToSet,
          current_step: "results",
          selfie_url: selfieUrl,
          is_verified: overallVerified,
          verification_score: verificationScore,
          liveness_score: livenessScore,
          face_match_score: similarity,
          expected_guest_count: expected,
          verified_guest_count: verifiedAfter,
          requires_additional_guest: requiresAdditionalGuest,
          updated_at: new Date().toISOString(),
        })
        .eq("session_token", session_token);

      if (updateError) {
        console.error("Error updating verification session:", updateError);
        return res.status(500).json({ error: "Failed to save verification result" });
      }

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
          verified: overallVerified,
          cost: 0.052,
        });
      } catch (e) {
        console.warn("increment_demo_stats failed (non-blocking):", e?.message || e);
      }

      return res.json({
        success: true,
        is_verified: overallVerified,
        expected_guest_count: expected,
        verified_guest_count: verifiedAfter,
        requires_additional_guest: requiresAdditionalGuest,
        remaining_guest_verifications: Math.max(expected - verifiedAfter, 0),
        data: {
          liveness_score: livenessScore,
          face_match_score: similarity,
          verification_score: verificationScore,
          is_verified: overallVerified,
          requires_additional_guest: requiresAdditionalGuest,
          expected_guest_count: expected,
          verified_guest_count: verifiedAfter,
          remaining_guest_verifications: Math.max(expected - verifiedAfter, 0),
        },
      });
    }

    return res.status(400).json({ error: "Invalid action" });
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ error: error?.message || "Unknown server error" });
  }
}
