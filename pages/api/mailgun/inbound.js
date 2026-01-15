import crypto from "crypto";
import formidable from "formidable";
import { createClient } from "@supabase/supabase-js";

export const config = { api: { bodyParser: false } };

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function setCors(res) {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Requested-With, Accept, Origin, Authorization"
  );
}

function parseForm(req) {
  const form = formidable({ multiples: true, keepExtensions: true });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

function toStr(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v[0]?.toString?.() ?? "";
  return v.toString?.() ?? "";
}

function verifyMailgunSignature(fields) {
  const apiKey = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
  if (!apiKey) return { ok: true, skipped: true };

  const timestamp = toStr(fields.timestamp);
  const token = toStr(fields.token);
  const signature = toStr(fields.signature);

  if (!timestamp || !token || !signature) {
    return { ok: false, reason: "Missing timestamp/token/signature" };
  }

  const hmac = crypto
    .createHmac("sha256", apiKey)
    .update(timestamp + token)
    .digest("hex");

  const ok = crypto.timingSafeEqual(
    Buffer.from(hmac, "utf8"),
    Buffer.from(signature, "utf8")
  );

  return ok ? { ok: true, skipped: false } : { ok: false, reason: "Bad signature" };
}

function normLower(s) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function normUpper(s) {
  return (s || "").toUpperCase().replace(/\s+/g, "").trim();
}

/**
 * Extract fields from Cloudbeds-like email text.
 * Works for your sample:
 * Guest Name JANE DOE
 * Confirmation Number 986CVPX4KK
 * Source Expedia
 * Source Reservation ID 837124221
 * Adults: 1 Children: 0
 */
function extractBooking(bodyText, subjectText = "") {
  const text = bodyText || "";

  const guestNameRaw =
    (text.match(/Guest Name\s+([^\r\n]+)/i)?.[1] || "").trim();

  const confirmationRaw =
    (text.match(/Confirmation Number\s+([A-Z0-9-]+)/i)?.[1] || "").trim() ||
    // fallback: sometimes it’s only in subject
    (subjectText.match(/Confirmation Number\s+([A-Z0-9-]+)/i)?.[1] || "").trim();

  const sourceRaw =
    (text.match(/Source\s+([^\r\n]+)/i)?.[1] || "").trim();

  const sourceResIdRaw =
    (text.match(/Source Reservation ID\s+([A-Z0-9-]+)/i)?.[1] || "").trim();

  const adults =
    parseInt(text.match(/Adults:\s*(\d+)/i)?.[1] || "0", 10) || 0;

  const children =
    parseInt(text.match(/Children:\s*(\d+)/i)?.[1] || "0", 10) || 0;

  return {
    guest_name_raw: guestNameRaw,
    guest_name_norm: normLower(guestNameRaw),

    confirmation_number_raw: confirmationRaw,
    confirmation_number_norm: normUpper(confirmationRaw), // keeps your table style (no spaces, uppercase)

    source_reservation_id_raw: sourceResIdRaw,
    source_reservation_id_norm: normUpper(sourceResIdRaw),

    source: sourceRaw || null,
    adults,
    children,
  };
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { fields } = await parseForm(req);

    // 1) Verify Mailgun authenticity (now that you added the key)
    const sig = verifyMailgunSignature(fields);
    if (!sig.ok) {
      console.warn("❌ Mailgun signature failed:", sig.reason);
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    // 2) Pull safe top-level fields
    const recipient = toStr(fields.recipient);
    const from = toStr(fields.from);
    const subject = toStr(fields.subject);

    // 3) Prefer stripped-text for parsing
    const strippedText = toStr(fields["stripped-text"]);
    const bodyPlain = toStr(fields["body-plain"]);
    const bodyText = strippedText || bodyPlain || "";

    // 4) Extract Cloudbeds fields (THIS is where extraction happens)
    const extracted = extractBooking(bodyText, subject);

    // 5) Minimal, non-sensitive logs (THIS is where logging is controlled)
    console.log("📩 Mailgun inbound received", {
      recipient,
      from,
      subject,
      extracted,
      bodyPreview: bodyText.slice(0, 200),
    });

    // 6) Insert into your existing table booking_email_index
    const { data, error } = await supabase
      .from("booking_email_index")
      .insert({
        guest_name_raw: extracted.guest_name_raw,
        guest_name_norm: extracted.guest_name_norm,
        confirmation_number_raw: extracted.confirmation_number_raw,
        confirmation_number_norm: extracted.confirmation_number_norm,
        source_reservation_id_raw: extracted.source_reservation_id_raw,
        source_reservation_id_norm: extracted.source_reservation_id_norm,
        source: extracted.source,
        raw_text: bodyText, // you already have raw_text in the table
        adults: extracted.adults,
        children: extracted.children,
      })
      .select("id")
      .single();

    if (error) {
      console.error("❌ Supabase insert error:", error);
      return res.status(500).json({ success: false, error: "DB insert failed" });
    }

    return res.status(200).json({
      success: true,
      verified: sig.skipped ? "skipped" : true,
      inserted_id: data?.id,
      recipient,
      subject,
      extracted,
    });
  } catch (err) {
    console.error("❌ inbound error:", err);
    return res.status(400).json({ success: false, error: "Parse failed" });
  }
}
