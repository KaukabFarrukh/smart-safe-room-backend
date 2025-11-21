require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 5000;

// Azure OpenAI API version
const AZURE_OPENAI_API_VERSION = '2024-12-01-preview';

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Allows large base64 images

// -------------------------------------------
// 🔍 ADVANCED SIGNALS HELPER
// -------------------------------------------
function computeAdvancedSignals(visionObjects) {
  // persons detected
  const persons = (visionObjects || []).filter((o) =>
    (o.object || "").toLowerCase().includes("person")
  );

  const peopleCount = persons.length;

  // fall detection heuristic
  let fallRisk = false;
  for (const p of persons) {
    const rect = p.rectangle || {};
    const w = rect.w || 0;
    const h = rect.h || 1;
    const aspectRatio = w / h;

    // if width > height significantly → lying down
    if (aspectRatio > 1.35) {
      fallRisk = true;
      break;
    }
  }

  return {
    peopleCount,
    fallRisk,
    voiceStress: false, // placeholder for now
  };
}

// -------------------------------------------
// Health check
// -------------------------------------------
app.get('/', (req, res) => {
  res.send('Smart Safe Room AI backend is running ✅');
});

// -------------------------------------------
// 📸 MAIN ANALYSIS ROUTE
// -------------------------------------------
app.post('/analyze-room', async (req, res) => {
  try {
    const { imageBase64 } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: 'imageBase64 is required' });
    }

    const imageBuffer = Buffer.from(imageBase64, 'base64');

    // -------------------------------------------
    // 1) CALL AZURE VISION
    // -------------------------------------------
    const visionUrl =
      `${process.env.AZURE_VISION_ENDPOINT}/vision/v3.2/analyze` +
      `?visualFeatures=Description,Tags,Objects`;

    const visionResponse = await axios.post(visionUrl, imageBuffer, {
      headers: {
        'Ocp-Apim-Subscription-Key': process.env.AZURE_VISION_KEY,
        'Content-Type': 'application/octet-stream',
      },
    });

    const vision = visionResponse.data;

    // caption
    const caption =
      vision.description?.captions?.[0]?.text || 'No caption available';

    // tags
    const tags = (vision.tags || []).map((t) => t.name);

    // NEW: advanced safety signals
    const signals = computeAdvancedSignals(vision.objects);
    const peopleCount = signals.peopleCount;

    // Create scene description sent to OpenAI
    const sceneDescription = `Caption: ${caption}
People detected: ${peopleCount}
Tags: ${tags.join(', ')}`;

    // -------------------------------------------
    // 2) CALL AZURE OPENAI
    // -------------------------------------------
    const openaiUrl =
      `${process.env.AZURE_OPENAI_ENDPOINT}` +
      `/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}/chat/completions` +
      `?api-version=${AZURE_OPENAI_API_VERSION}`;

    const userPrompt = `
You are a safety assistant monitoring a room using camera snapshots.

Here is the machine vision description of the scene:

${sceneDescription}

Decide:
- status: "NORMAL", "WARNING", or "EMERGENCY"
- reason: 1–2 short sentences
- action: one short sentence telling the app what to do next.

Return ONLY valid JSON:
{"status":"NORMAL","reason":"...","action":"..."}
`;

    const openaiResponse = await axios.post(
      openaiUrl,
      {
        messages: [
          { role: 'system', content: 'You are a concise safety reasoning assistant.' },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 300,
      },
      {
        headers: {
          'api-key': process.env.AZURE_OPENAI_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    const message = openaiResponse.data.choices[0].message.content;

    let aiDecision;
    try {
      aiDecision = JSON.parse(message);
    } catch (err) {
      aiDecision = {
        status: 'WARNING',
        reason: 'Could not parse model JSON response.',
        action: 'Show warning and log for review.',
        rawResponse: message,
      };
    }

    // -------------------------------------------
    // 3) FINAL RESPONSE SENT TO FRONTEND
    // -------------------------------------------
    res.json({
      sceneDescription,
      caption,
      tags,

      // basic
      peopleCount,

      // AI reasoning
      aiDecision,

      // NEW: advanced safety signals (the frontend is already using these)
      signals: {
        fallRisk: signals.fallRisk,
        voiceStress: signals.voiceStress,
      }
    });

  } catch (err) {
    console.error('Error in /analyze-room:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Analysis failed',
      details: err.response?.data || err.message,
    });
  }
});

app.listen(port, () => {
  console.log(`Smart Safe Room backend listening on http://localhost:${port}`);
});
