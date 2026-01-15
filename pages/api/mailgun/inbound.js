import formidable from "formidable";

export const config = {
  api: {
    bodyParser: false, // IMPORTANT: let formidable handle it
  },
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*"); // tighten later
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Requested-With, Accept, Origin, Authorization"
  );
}

function parseForm(req) {
  const form = formidable({
    multiples: true,
    // Mailgun payloads are usually small; keep defaults unless you hit limits
  });

  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

export default async function handler(req, res) {
  setCors(res);

  // Browser preflight (not required for Mailgun server-to-server, but fine)
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { fields, files } = await parseForm(req);

    console.log("📩 Mailgun inbound received");
    console.log("headers:", req.headers);

    // fields = the inbound email payload
    // files = attachments (if any)
    console.log("fields keys:", Object.keys(fields));
    console.log("recipient:", fields.recipient);
    console.log("from:", fields.from);
    console.log("subject:", fields.subject);

    // Common useful bodies from Mailgun:
    // - "body-plain"
    // - "stripped-text"
    // - "body-html"
    const bodyPlain =
      (fields["stripped-text"] || fields["body-plain"] || "").toString();

    console.log("body preview:", bodyPlain.slice(0, 500));

    return res.status(200).json({
      success: true,
      received: {
        recipient: fields.recipient,
        from: fields.from,
        subject: fields.subject,
      },
    });
  } catch (err) {
    console.error("❌ inbound parse error:", err);
    return res.status(400).json({ success: false, error: "Parse failed" });
  }
}
