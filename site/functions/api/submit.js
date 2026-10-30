/**
 * POST /api/submit
 * Receives the Morianah signup form and emails it to the inbox via Resend.
 *
 * Requires one environment variable set in the Cloudflare Pages project:
 *   RESEND_API_KEY   -> your Resend API key (Pages > Settings > Variables and Secrets)
 *
 * The destination inbox is set in TO_EMAIL below.
 */

const TO_EMAIL = "morianahincorporated@gmail.com";

// Using Resend's shared sender lets you start WITHOUT verifying a domain.
// Note: with this shared sender, Resend only delivers to your own Resend
// account email — so sign up for Resend using TO_EMAIL above.
// Later, verify morianahinc.com in Resend and change FROM_EMAIL to something
// like "Morianah <hello@morianahinc.com>" to send to any address.
const FROM_EMAIL = "Morianah <onboarding@resend.dev>";

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const form = await request.formData();

    // Honeypot: real users never fill this hidden field; bots do.
    // Pretend success so the bot moves on, but send nothing.
    if ((form.get("_honey") || "").toString().trim()) {
      return json({ ok: true });
    }

    const role = (form.get("role") || "").toString().trim();
    const first = (form.get("first") || "").toString().trim();
    const last = (form.get("last") || "").toString().trim();
    const email = (form.get("email") || "").toString().trim();

    if (!role || !first || !last || !email) {
      return json({ ok: false, error: "Please fill in every field." }, 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ ok: false, error: "Please enter a valid email." }, 400);
    }

    if (!env.RESEND_API_KEY) {
      return json({ ok: false, error: "Email service not configured." }, 500);
    }

    const subject = `New Morianah signup — ${role}`;
    const text =
      `New signup from the Morianah site\n\n` +
      `Role:  ${role}\n` +
      `Name:  ${first} ${last}\n` +
      `Email: ${email}\n`;
    const html =
      `<h2 style="font-family:sans-serif">New Morianah signup</h2>` +
      `<table cellpadding="8" style="border-collapse:collapse;font-family:sans-serif">` +
      `<tr><td><b>Role</b></td><td>${esc(role)}</td></tr>` +
      `<tr><td><b>Name</b></td><td>${esc(first)} ${esc(last)}</td></tr>` +
      `<tr><td><b>Email</b></td><td>${esc(email)}</td></tr>` +
      `</table>`;

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [TO_EMAIL],
        reply_to: email,
        subject,
        text,
        html,
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      return json({ ok: false, error: "Email service error.", detail }, 502);
    }

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: "Server error." }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json;charset=utf-8" },
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
