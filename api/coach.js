// Vercel serverless function: POST /api/coach
// Keeps your Anthropic API key on the server — never shipped to the browser.
// Set ANTHROPIC_API_KEY in Vercel project settings (Environment Variables).

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY not configured on server" });
    return;
  }

  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ error: "Missing 'prompt' string in request body" });
    return;
  }

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const text = await anthropicRes.text();
      res.status(anthropicRes.status).json({ error: "Anthropic API error", detail: text });
      return;
    }

    const data = await anthropicRes.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: "Request failed", detail: String(err) });
  }
}
