const apiKey = process.env.ELEVENLABS_API_KEY;

if (!apiKey) {
  console.error("Nedostaje ELEVENLABS_API_KEY. Napravi .env iz .env.example i unesi ključ lokalno.");
  process.exit(1);
}

const response = await fetch("https://api.elevenlabs.io/v1/convai/agents", {
  headers: { "xi-api-key": apiKey },
});

let body = {};
try {
  body = await response.json();
} catch {
  body = {};
}

if (!response.ok) {
  console.error(`ElevenLabs API nije prihvatio ključ (HTTP ${response.status}).`);
  process.exit(1);
}

const agents = Array.isArray(body) ? body : (Array.isArray(body.agents) ? body.agents : []);
console.log(JSON.stringify({
  ok: true,
  permission: "ElevenAgents: Write",
  agents_visible: agents.length,
}, null, 2));
