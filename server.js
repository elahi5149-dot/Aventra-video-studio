require("dotenv").config();
const Groq = require("groq-sdk");
const { fal } = require("@fal-ai/client");

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { execFile, spawnSync } = require("child_process");

const app = express();
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// ============================

app.use(express.json({
  verify: (req, res, buf) => {
    if (req.originalUrl === "/api/payment/safepay/webhook") {
      req.rawBody = Buffer.from(buf);
    }
  }
}));
const { Pool } = require("pg");

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

async function initDatabase() {
  if (!pool) {
    console.log("ℹ️ DATABASE_URL not set - using local users.json");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      plan TEXT DEFAULT 'free',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log("✅ PostgreSQL users table ready");
}

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const usersFile = path.join(__dirname, "users.json");

function loadUsers() {
  try {
    if (!fs.existsSync(usersFile)) {
      fs.writeFileSync(usersFile, "[]");
    }

    return JSON.parse(fs.readFileSync(usersFile, "utf8"));
  } catch (error) {
    console.error("Users file error:", error);
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(
    usersFile,
    JSON.stringify(users, null, 2)
  );
}

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "7d"
    }
  );
}

// ============================
// ============================
// Contact & Support API
// ============================

const supportFile = path.join(__dirname, "support-messages.json");

function loadSupportMessages() {
  try {
    if (!fs.existsSync(supportFile)) {
      fs.writeFileSync(supportFile, "[]");
    }

    return JSON.parse(
      fs.readFileSync(supportFile, "utf8")
    );
  } catch (error) {
    console.error("Support file error:", error);
    return [];
  }
}

function saveSupportMessages(messages) {
  fs.writeFileSync(
    supportFile,
    JSON.stringify(messages, null, 2)
  );
}

app.post("/api/support", (req, res) => {
  try {
    const { name, email, message } = req.body || {};

    if (!name || !email || !message) {
      return res.status(400).json({
        success: false,
        message: "Name, email and message are required"
      });
    }

    const cleanName = String(name).trim();
    const cleanEmail = String(email).trim().toLowerCase();
    const cleanMessage = String(message).trim();

    if (!cleanName || !cleanEmail || !cleanMessage) {
      return res.status(400).json({
        success: false,
        message: "Please fill all fields"
      });
    }

    if (cleanMessage.length > 5000) {
      return res.status(400).json({
        success: false,
        message: "Message is too long"
      });
    }

    const messages = loadSupportMessages();

    const supportMessage = {
      id: Date.now().toString(),
      name: cleanName,
      email: cleanEmail,
      message: cleanMessage,
      createdAt: new Date().toISOString(),
      status: "open"
    };

    messages.push(supportMessage);
    saveSupportMessages(messages);

    console.log(
      `📩 New support request from ${cleanName} (${cleanEmail})`
    );

    res.json({
      success: true,
      message: "Support request sent successfully"
    });

  } catch (error) {
    console.error("Support API error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to send support request"
    });
  }
});

// TEMP USER MIGRATION
app.post("/api/temp-migrate-user", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ success: false, message: "Database unavailable" });

    const email = process.env.MIGRATE_EMAIL;
    const password = process.env.MIGRATE_PASSWORD;

    if (!email || !password) {
      return res.status(500).json({ success: false, message: "Migration credentials missing" });
    }

    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);

    if (existing.rows.length) {
      return res.json({ success: true, message: "User already exists in database" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = {
      id: Date.now().toString(),
      name: "Fazal",
      email: email.toLowerCase(),
      password: hashedPassword,
      plan: "free"
    };

    await pool.query(
      "INSERT INTO users (id, name, email, password, plan) VALUES ($1, $2, $3, $4, $5)",
      [user.id, user.name, user.email, user.password, user.plan]
    );

    res.json({ success: true, message: "User migrated successfully" });
  } catch (error) {
    console.error("Migration error:", error);
    res.status(500).json({ success: false, message: "Migration failed" });
  }
});

// User Signup
// ============================

app.post("/api/auth/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Name, email and password are required"
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters"
      });
    }

    const cleanEmail = String(email).trim().toLowerCase();

    const users = loadUsers();

    const existingUser = users.find(
      user => user.email === cleanEmail
    );

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "Email is already registered"
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = {
      id: Date.now().toString(),
      name: String(name).trim(),
      email: cleanEmail,
      password: hashedPassword,
      plan: "free",
      createdAt: new Date().toISOString()
    };

    users.push(user);
    saveUsers(users);

    const token = createToken(user);

    res.status(201).json({
      success: true,
      message: "Account created successfully",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        plan: user.plan
      }
    });

  } catch (error) {
    console.error("Signup error:", error);

    res.status(500).json({
      success: false,
      message: "Signup failed"
    });
  }
});

// ============================
// User Login
// ============================

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required"
      });
    }

    const cleanEmail = String(email).trim().toLowerCase();

    const users = loadUsers();

    const user = users.find(
      user => user.email === cleanEmail
    );

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password"
      });
    }

    const passwordMatch = await bcrypt.compare(
      password,
      user.password
    );

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password"
      });
    }

    const token = createToken(user);

    res.json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        plan: user.plan
      }
    });

  } catch (error) {
    console.error("Login error:", error);

    res.status(500).json({
      success: false,
      message: "Login failed"
    });
  }
});

// ============================
// JWT Authentication Middleware
// ============================

function authenticateUser(req, res, next) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Authentication required"
    });
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    req.user = decoded;
    next();

  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token"
    });
  }
}

// ============================
// Current User
// ============================

app.get("/api/auth/me", authenticateUser, (req, res) => {

  const users = loadUsers();

  const user = users.find(
    user => user.id === req.user.id
  );

  if (!user) {
    return res.status(404).json({
      success: false,
      message: "User not found"
    });
  }

  res.json({
    success: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      plan: user.plan,
      createdAt: user.createdAt
    }
  });
});




// ============================

// ============================
// Aventra Plans
// ============================

const AVENTRA_PLANS = {
  free: {
    name: "Free",
    price: 0,
    currency: "USD",
    description: "Basic video editing"
  },

  pro: {
    name: "Pro",
    price: 9.99,
    currency: "USD",
    description: "Advanced video editing and AI features"
  },

  premium: {
    name: "Premium",
    price: 19.99,
    currency: "USD",
    description: "All Aventra features"
  }
};

// Public plan list
app.get("/api/plans", (req, res) => {
  res.json({
    success: true,
    plans: AVENTRA_PLANS
  });
});

// YouTube Automation - AI Voice
// ============================

app.post("/api/youtube/voice", async (req, res) => {
  try {
    const { text, voice = "ur-PK-UzmaNeural" } = req.body || {};

    if (!text || !text.trim()) {
      return res.status(400).json({
        success: false,
        message: "Text is required"
      });
    }

    const safeVoice = [
      "ur-PK-UzmaNeural",
      "ur-PK-AsadNeural"
    ].includes(voice) ? voice : "ur-PK-UzmaNeural";

    const filename = `youtube_voice_${Date.now()}.mp3`;
    const outputPath = path.join(outputDir, filename);

    const { spawn } = require("child_process");

    const process = spawn("python", [
      "-m",
      "edge_tts",
      "--voice",
      safeVoice,
      "--text",
      text,
      "--write-media",
      outputPath
    ]);

    let errorOutput = "";

    process.stderr.on("data", data => {
      errorOutput += data.toString();
    });

    process.on("close", code => {
      if (code !== 0 || !fs.existsSync(outputPath)) {
        console.error("Edge TTS error:", errorOutput);

        return res.status(500).json({
          success: false,
          message: "Voice generation failed"
        });
      }

      res.json({
        success: true,
        voice: safeVoice,
        audioUrl: `/outputs/${filename}`
      });
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.use(express.urlencoded({ extended: true }));

app.post("/api/youtube/script", async (req, res) => {
  try {
    const {
      topic,
      category = "General",
      language = "English",
      duration = "5",
      style = "Documentary"
    } = req.body || {};

    if (!topic || !topic.trim()) {
      return res.status(400).json({
        success: false,
        message: "Topic is required"
      });
    }

    const prompt = `
Create a complete YouTube video script.

Category: ${category}
Topic: ${topic}
Language: ${language}
Target duration: ${duration} minutes
Style: ${style}

Requirements:
- Create an engaging title
- Start with a strong hook
- Write a clear introduction
- Create well-structured main content
- Make the narration natural for AI voice-over
- End with an engaging conclusion
- Include a short call to action
- Return only the script content
`;

    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      messages: [
        {
          role: "system",
          content: "You are an expert YouTube script writer."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: 5000
    });

    const script = completion.choices?.[0]?.message?.content || "";

    if (!script) {
      return res.status(500).json({
        success: false,
        message: "AI did not return a script"
      });
    }

    res.json({
      success: true,
      topic,
      language,
      duration,
      style,
      script
    });

  } catch (error) {
    console.error("YouTube Script Error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to generate script"
    });
  }
});


const PORT = process.env.PORT || 3000;

const uploadDir = path.join(__dirname, "uploads");
const outputDir = path.join(__dirname, "outputs");

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);



// ============================
// YouTube Automation - AI Scenes
// ============================


// ============================
// YouTube Automation - AI Image
// ============================

app.post("/api/youtube/image", async (req, res) => {
  try {
    const { prompt } = req.body || {};

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({
        success: false,
        message: "Image prompt is required"
      });
    }

    const encodedPrompt = encodeURIComponent(prompt.trim());

    const imageUrl =
      `https://image.pollinations.ai/prompt/${encodedPrompt}` +
      `?width=1280&height=720&nologo=true`;

    res.json({
      success: true,
      imageUrl
    });

  } catch (error) {
    console.error("❌ AI IMAGE ERROR:", error);

    res.status(500).json({
      success: false,
      message: error?.message || "Image generation failed"
    });
  }
});

// ============================
 // YouTube Automation - Thumbnail
 // ============================
 app.post("/api/youtube/thumbnail", async (req, res) => {
  try {
    const { prompt } = req.body || {};

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({
        success: false,
        message: "Thumbnail prompt is required"
      });
    }

    const thumbnailPrompt =
      `${prompt.trim()}, YouTube thumbnail, cinematic,
      highly clickable, dramatic lighting, professional
      documentary style, detailed, 16:9 composition,
      no watermark, no text`;

    const encodedPrompt =
      encodeURIComponent(thumbnailPrompt);

    const imageUrl =
      `https://image.pollinations.ai/prompt/${encodedPrompt}` +
      `?width=1280&height=720&nologo=true`;

    console.log("🖼️ Generating YouTube thumbnail...");

    const response = await fetch(imageUrl);

    if (!response.ok) {
      throw new Error(
        `Thumbnail image failed: HTTP ${response.status}`
      );
    }

    const imageBuffer =
      Buffer.from(await response.arrayBuffer());

    if (!imageBuffer.length) {
      throw new Error("Thumbnail image is empty");
    }

    const filename =
      `youtube_thumbnail_${Date.now()}.jpg`;

    const filepath =
      path.join(outputDir, filename);

    fs.writeFileSync(filepath, imageBuffer);

    console.log(`✅ YouTube thumbnail saved: ${filename}`);

    res.json({
      success: true,
      imageUrl: `/outputs/${filename}`
    });

  } catch (error) {
    console.error(
      "❌ YOUTUBE THUMBNAIL ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        error?.message ||
        "Thumbnail generation failed"
    });
  }
});

// ============================
 // YouTube Automation - SEO
 // ============================
 app.post("/api/youtube/seo", async (req, res) => {
   try {
     const {
       topic,
       script = "",
       language = "English"
     } = req.body || {};

     if (!topic || !topic.trim()) {
       return res.status(400).json({
         success: false,
         message: "Topic is required"
       });
     }

     const prompt = `
Create complete YouTube SEO metadata.

Topic: ${topic}
Language: ${language}

Video Script:
${script.slice(0, 12000)}

Return ONLY valid JSON in this exact format:

{
  "title": "SEO optimized YouTube title",
  "description": "SEO optimized YouTube description",
  "keywords": ["keyword 1", "keyword 2", "keyword 3"],
  "tags": ["tag 1", "tag 2", "tag 3"],
  "hashtags": ["#Hashtag1", "#Hashtag2", "#Hashtag3"]
}

Requirements:
- Create an attractive clickable title.
- Keep the title suitable for YouTube.
- Write a useful SEO-friendly description.
- Generate relevant search keywords.
- Generate relevant YouTube tags.
- Generate relevant hashtags.
- Do not use misleading or spammy keywords.
- Match the requested language.
`;

     const completion =
       await groq.chat.completions.create({
         model: "openai/gpt-oss-120b",
         messages: [
           {
             role: "system",
             content:
               "You are an expert YouTube SEO specialist. Return valid JSON only."
           },
           {
             role: "user",
             content: prompt
           }
         ],
         temperature: 0.5,
         max_tokens: 3000
       });

     let content =
       completion.choices?.[0]?.message?.content || "";

     if (!content) {
       throw new Error("AI did not return SEO data");
     }

     content = content
       .replace(/^```json\s*/i, "")
       .replace(/^```\s*/i, "")
       .replace(/\s*```$/i, "")
       .trim();

     let seo;

     try {
       seo = JSON.parse(content);
     } catch {
       throw new Error("AI returned invalid SEO JSON");
     }

     res.json({
       success: true,
       topic,
       language,
       seo
     });

   } catch (error) {
     console.error("❌ YouTube SEO Error:", error);

     res.status(500).json({
       success: false,
       message:
         error?.message ||
         "Failed to generate YouTube SEO"
     });
   }
 });

app.post("/api/youtube/scenes", async (req, res) => {
  try {
    const { script, sceneCount = 8 } = req.body || {};

    if (!script || !script.trim()) {
      return res.status(400).json({
        success: false,
        message: "Script is required"
      });
    }

    const count = Math.min(
      Math.max(parseInt(sceneCount) || 8, 3),
      15
    );

    const prompt = `
You are a professional YouTube documentary visual planner.

Convert the following YouTube script into exactly ${count} visual scenes.

For every scene return:
1. scene number
2. short narration summary
3. detailed AI image prompt
4. approximate duration in seconds

Rules:
- Keep scenes in the same order as the script.
- Make each image visually different.
- Use realistic cinematic documentary photography.
- Describe location, people, environment, lighting and camera composition.
- Do not include text, logos, captions or watermarks inside images.
- Return ONLY valid JSON.
- JSON format:

[
  {
    "scene": 1,
    "summary": "...",
    "prompt": "...",
    "duration": 8
  }
]

SCRIPT:
${script}
`;

    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      messages: [
        {
          role: "system",
          content: "You are an expert YouTube documentary visual planner. Return valid JSON only."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.5,
      max_tokens: 6000
    });

    const raw = completion.choices?.[0]?.message?.content || "";

    let scenes;

    try {
      const cleaned = raw
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      scenes = JSON.parse(cleaned);
    } catch (parseError) {
      console.error("Scene JSON parse error:", parseError);
      console.error("Groq response:", raw);

      return res.status(500).json({
        success: false,
        message: "AI returned invalid scene data",
        raw
      });
    }

    if (!Array.isArray(scenes)) {
      return res.status(500).json({
        success: false,
        message: "Invalid scenes format"
      });
    }

    res.json({
      success: true,
      sceneCount: scenes.length,
      scenes
    });

  } catch (error) {
    console.error("YouTube scenes error:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});


// ============================
// YouTube Automation - AI Script


app.get("/api/paddle/config", (req, res) => {
  res.json({
    clientToken: process.env.PADDLE_CLIENT_TOKEN || ""
  });
});

app.use(express.static(path.join(__dirname, "public")));

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `video_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("video/")) {
      cb(null, true);
    } else {
      cb(new Error("Only video files are allowed"));
    }
  }
});

const musicUpload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    const videoExts = [".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"];
    const audioExts = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"];

    if (file.fieldname === "video" && videoExts.includes(ext)) {
      return cb(null, true);
    }

    if (file.fieldname === "music" && audioExts.includes(ext)) {
      return cb(null, true);
    }

    cb(new Error("Invalid video or audio file"));
  }
});

// ============================
// Add Text to Video
// ============================

app.post("/api/video/text", musicUpload.single("video"), (req, res) => {

  try {

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Video is required"
      });
    }

    const video = req.file;

    const text = String(req.body.text || "").trim();

    if (!text) {
      fs.unlink(video.path, () => {});
      return res.status(400).json({
        success: false,
        message: "Text is required"
      });
    }

    const size = Math.max(
      12,
      Math.min(120, Number(req.body.size || 32))
    );

    const position = req.body.position || "center";

    // Text color
    // Accept HEX colors from the color picker, e.g. #ff0000
    const requestedColor = String(req.body.color || "").trim();

    const color = /^#[0-9a-fA-F]{6}$/.test(requestedColor)
      ? requestedColor
      : "white";

    let y = "(h-text_h)/2";

    if (position === "top") {
      y = "50";
    }

    if (position === "bottom") {
      y = "h-text_h-50";
    }

    const safeText = text
      .replace(/\\/g, "\\\\")
      .replace(/:/g, "\\:")
      .replace(/'/g, "\\'")
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]");

    const outputName = `text_${Date.now()}.mp4`;
    const outputPath = path.join(outputDir, outputName);

    const filter =
      `drawtext=text='${safeText}':fontsize=${size}:fontcolor=${color}:` +
      `borderw=3:bordercolor=black:x=(w-text_w)/2:y=${y}`;

    execFile(
      "ffmpeg",
      [
        "-y",
        "-i",
        video.path,
        "-vf",
        filter,
        "-c:v",
        "libx264",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        outputPath
      ],
      (error, stdout, stderr) => {

        fs.unlink(video.path, () => {});

        if (error) {

          console.error(
            "FFMPEG TEXT ERROR:",
            stderr || error.message
          );

          return res.status(500).json({
            success: false,
            message: "Text processing failed"
          });
        }

        res.json({
          success: true,
          message: "Text added successfully",
          videoUrl: `/outputs/${outputName}`
        });

      }
    );

  } catch (error) {

    console.error("TEXT ERROR:", error);

    if (req.file) {
      fs.unlink(req.file.path, () => {});
    }

    res.status(500).json({
      success: false,
      message: "Server error"
    });

  }

});


// ============================
// Advanced Video Effects
// ============================

app.post("/api/video/effects", musicUpload.single("video"), (req, res) => {

  try {

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Video is required"
      });
    }

    const video = req.file;

    const preset = String(req.body.preset || "none");

    const clamp = (value, min, max, fallback) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return fallback;
      return Math.max(min, Math.min(max, n));
    };

    const brightness = clamp(req.body.brightness, -1, 1, 0);
    const contrast = clamp(req.body.contrast, 0, 3, 1);
    const saturation = clamp(req.body.saturation, 0, 3, 1);
    const blur = clamp(req.body.blur, 0, 20, 0);
    const sharpen = clamp(req.body.sharpen, 0, 5, 0);
    const vignette = clamp(req.body.vignette, 0, 1, 0);
    const grain = clamp(req.body.grain, 0, 1, 0);
    const rgbSplit = clamp(req.body.rgbSplit, 0, 20, 0);
    const glow = clamp(req.body.glow, 0, 20, 0);
    const pixelate = clamp(req.body.pixelate, 0, 20, 0);
    const scanlines = clamp(req.body.scanlines, 0, 1, 0);

    const temperature = clamp(req.body.temperature, -100, 100, 0);
    const hue = clamp(req.body.hue, -180, 180, 0);
    const highlights = clamp(req.body.highlights, -1, 1, 0);
    const shadows = clamp(req.body.shadows, -1, 1, 0);
    const bars = clamp(req.body.bars, 0, 1, 0);

    const filters = [];

    // Presets
    if (preset === "cinematic") {
      filters.push("eq=contrast=1.15:saturation=1.15:brightness=0.02");
      filters.push("colorbalance=rs=.05:gs=-.01:bs=-.03");
    }

    if (preset === "vintage") {
      filters.push("eq=contrast=1.05:saturation=0.75:brightness=0.03");
      filters.push("colorchannelmixer=.95:.05:0:0:.9:.1:0:0:.8");
    }

    if (preset === "noir") {
      filters.push("hue=s=0");
      filters.push("eq=contrast=1.35:brightness=-0.03");
    }

    if (preset === "warm") {
      filters.push("colorbalance=rs=.10:gs=.03:bs=-.08");
      filters.push("eq=saturation=1.08");
    }

    if (preset === "cool") {
      filters.push("colorbalance=rs=-.08:gs=.02:bs=.12");
      filters.push("eq=saturation=1.05");
    }

    if (preset === "vibrant") {
      filters.push("eq=contrast=1.12:saturation=1.45:brightness=0.02");
    }

    // Manual adjustments
    if (
      brightness !== 0 ||
      contrast !== 1 ||
      saturation !== 1
    ) {
      filters.push(
        `eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`
      );
    }

    if (blur > 0) {
      filters.push(`gblur=sigma=${blur}`);
    }

    if (sharpen > 0) {
      filters.push(
        `unsharp=5:5:${sharpen}:5:5:0`
      );
    }

    if (vignette > 0) {
      filters.push(
        `vignette=PI/${Math.max(1, 2 + vignette * 8)}`
      );
    }

    if (grain > 0) {
      filters.push(
        `noise=alls=${Math.round(grain * 35)}:allf=t+u`
      );
    }

    // Pro Color Temperature
    if (temperature !== 0) {
      const t = temperature / 100;
      filters.push(
        `colorbalance=rs=${(t * 0.35).toFixed(3)}:gs=${(t * 0.08).toFixed(3)}:bs=${(-t * 0.35).toFixed(3)}`
      );
    }

    // Hue
    if (hue !== 0) {
      filters.push(`hue=h=${hue}`);
    }

    // Highlights / Shadows
    if (highlights !== 0 || shadows !== 0) {
      filters.push(
        `curves=all='0/0 ${Math.max(0, 0.5 + shadows * 0.25).toFixed(3)}/${Math.max(0, 0.5 + highlights * 0.25).toFixed(3)} 1/1'`
      );
    }

    // RGB Split / Chromatic Aberration
    if (rgbSplit > 0) {
      const d = Math.max(1, Math.round(rgbSplit));
      filters.push(
        `chromashift=cbh=${d}:cbv=0:crh=-${d}:crv=0`
      );
    }

    // Glow / Soft Bloom
    if (glow > 0) {
      filters.push(
        `gblur=sigma=${Math.max(0.1, glow / 4)}`
      );
    }

    // Pixelate
    if (pixelate > 0) {
      const block = Math.max(2, Math.round(2 + pixelate * 3));
      filters.push(
        `scale=iw/${block}:ih/${block}:flags=neighbor,scale=iw:ih:flags=neighbor`
      );
    }

    // Cinematic Letterbox Bars
    if (bars > 0) {
      const bar = Math.round(80 * bars);
      filters.push(
        `drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill`
      );
      filters.push(
        `drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill`
      );
    }

    // Scanlines
    if (scanlines > 0) {
      const strength = Math.max(0.05, Math.min(0.8, scanlines * 0.8));
      filters.push(
        `drawgrid=w=iw:h=2:t=1:c=black@${strength}`
      );
    }

    if (filters.length === 0) {
      filters.push("null");
    }

    const outputName = `effects_${Date.now()}.mp4`;
    const outputPath = path.join(outputDir, outputName);

    execFile(
      "ffmpeg",
      [
        "-y",
        "-i",
        video.path,
        "-vf",
        filters.join(","),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        outputPath
      ],
      (error, stdout, stderr) => {

        fs.unlink(video.path, () => {});

        if (error) {

          console.error(
            "FFMPEG EFFECTS ERROR:",
            stderr || error.message
          );

          return res.status(500).json({
            success: false,
            message: "Effects processing failed"
          });
        }

        res.json({
          success: true,
          message: "Effects applied successfully",
          videoUrl: `/outputs/${outputName}`
        });

      }
    );

  } catch (error) {

    console.error("EFFECTS ERROR:", error);

    if (req.file?.path) {
      fs.unlink(req.file.path, () => {});
    }

    res.status(500).json({
      success: false,
      message: "Server error"
    });

  }

});


// ============================
// Video Upload + Trim
// ============================

app.post("/api/video/trim", upload.single("video"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Video is required"
      });
    }

    const start = Number(req.body.start || 0);
    const duration = Number(req.body.duration || 5);

    if (!Number.isFinite(start) || !Number.isFinite(duration)) {
      return res.status(400).json({
        success: false,
        message: "Invalid start or duration"
      });
    }

    if (start < 0 || duration <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid trim values"
      });
    }

    const inputPath = req.file.path;

    const outputName = `trimmed_${Date.now()}.mp4`;
    const outputPath = path.join(outputDir, outputName);

    execFile(
      "ffmpeg",
      [
        "-y",
        "-ss",
        String(start),
        "-i",
        inputPath,
        "-t",
        String(duration),
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        outputPath
      ],
      (error, stdout, stderr) => {

        fs.unlink(inputPath, () => {});

        if (error) {
          console.error("FFMPEG ERROR:", stderr || error.message);

          return res.status(500).json({
            success: false,
            message: "Video processing failed"
          });
        }

        res.json({
          success: true,
          message: "Video trimmed successfully",
          videoUrl: `/outputs/${outputName}`
        });
      }
    );

  } catch (error) {
    console.error("TRIM ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});


// ============================
// Add Music to Video
// ============================

app.post("/api/video/music", musicUpload.fields([
  { name: "video", maxCount: 1 },
  { name: "music", maxCount: 1 }
]), (req, res) => {
  try {
    if (!req.files?.video?.[0] || !req.files?.music?.[0]) {
      return res.status(400).json({
        success: false,
        message: "Video and music are required"
      });
    }

    const video = req.files.video[0];
    const music = req.files.music[0];

    const volume = Math.max(
      0,
      Math.min(
        2,
        Number(req.body.volume || 1)
      )
    );

    const outputName = `music_${Date.now()}.mp4`;
    const outputPath = path.join(outputDir, outputName);

    execFile(
      "ffmpeg",
      [
        "-y",

        "-i",
        video.path,

        "-stream_loop",
        "-1",
        "-i",
        music.path,

        "-filter_complex",
        `[1:a]volume=${volume}[music];` +
        `[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`,

        "-map",
        "0:v:0",

        "-map",
        "[aout]",

        "-c:v",
        "libx264",

        "-preset",
        "ultrafast",

        "-crf",
        "28",

        "-pix_fmt",
        "yuv420p",

        "-c:a",
        "aac",

        "-b:a",
        "128k",

        "-shortest",

        "-movflags",
        "+faststart",

        outputPath
      ],
      (error, stdout, stderr) => {

        fs.unlink(video.path, () => {});
        fs.unlink(music.path, () => {});

        if (error) {
          console.error(
            "FFMPEG MUSIC ERROR:",
            stderr || error.message
          );

          if (fs.existsSync(outputPath)) {
            fs.unlink(outputPath, () => {});
          }

          return res.status(500).json({
            success: false,
            message: "Music processing failed"
          });
        }

        res.json({
          success: true,
          message: "Music added successfully",
          videoUrl: `/outputs/${outputName}`
        });
      }
    );

  } catch (error) {
    console.error("MUSIC ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

// Serve processed videos
app.use(
  "/outputs",
  express.static(outputDir)
);
// ============================
// Merge Videos
// ============================

app.post("/api/video/merge", upload.array("videos", 10), (req, res) => {
  try {
    if (!req.files || req.files.length < 2) {
      return res.status(400).json({
        success: false,
        message: "At least 2 videos are required"
      });
    }

    const listName = `merge_${Date.now()}.txt`;
    const listPath = path.join(outputDir, listName);

    const outputName = `merged_${Date.now()}.mp4`;
    const outputPath = path.join(outputDir, outputName);

    const fileList = req.files
      .map(file => {
        const safePath = file.path.replace(/'/g, "'\\''");
        return `file '${safePath}'`;
      })
      .join("\n");

    fs.writeFileSync(listPath, fileList);

    execFile(
      "ffmpeg",
      [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,

        "-vf",
        "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2",

        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "28",
        "-pix_fmt", "yuv420p",

        "-c:a", "aac",
        "-b:a", "128k",

        "-movflags", "+faststart",
        outputPath
      ],
      (error, stdout, stderr) => {

        req.files.forEach(file => {
          fs.unlink(file.path, () => {});
        });

        fs.unlink(listPath, () => {});

        if (error) {
          console.error(
            "FFMPEG MERGE ERROR:",
            stderr || error.message
          );

          if (fs.existsSync(outputPath)) {
            fs.unlink(outputPath, () => {});
          }

          return res.status(500).json({
            success: false,
            message: "Video merge failed"
          });
        }

        res.json({
          success: true,
          message: "Videos merged successfully",
          videoUrl: `/outputs/${outputName}`
        });
      }
    );

  } catch (error) {
    console.error("MERGE ERROR:", error);

    if (req.files) {
      req.files.forEach(file => {
        fs.unlink(file.path, () => {});
      });
    }

    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

// ============================
// Add Sticker to Video
// ============================

const stickerUpload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const mime = String(file.mimetype || "").toLowerCase();

    const imageExts = [".png", ".jpg", ".jpeg", ".webp"];
    const imageMimes = [
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/webp"
    ];

    // Allow the current video
    if (
      file.fieldname === "video" &&
      (
        ext === ".mp4" ||
        ext === ".webm" ||
        ext === ".mov" ||
        ext === ".mkv" ||
        ext === ".avi" ||
        ext === ".m4v" ||
        mime.startsWith("video/")
      )
    ) {
      return cb(null, true);
    }

    // Allow sticker images
    if (
      file.fieldname === "sticker" &&
      (
        imageExts.includes(ext) ||
        imageMimes.includes(mime)
      )
    ) {
      return cb(null, true);
    }

    console.log("❌ Sticker rejected:", {
      fieldname: file.fieldname,
      originalname: file.originalname,
      mimetype: file.mimetype
    });

    cb(new Error("Invalid video or sticker file"));
  }
});

app.post("/api/video/sticker", stickerUpload.fields([
  { name: "video", maxCount: 1 },
  { name: "sticker", maxCount: 1 }
]), (req, res) => {

  try {

    if (!req.files?.video?.[0] || !req.files?.sticker?.[0]) {
      return res.status(400).json({
        success: false,
        message: "Video and sticker are required"
      });
    }

    const video = req.files.video[0];
    const sticker = req.files.sticker[0];

    const position = String(req.body.position || "center");

    const size = Math.max(
      50,
      Math.min(1000, Number(req.body.size || 300))
    );

    const opacity = Math.max(
      0,
      Math.min(1, Number(req.body.opacity || 1))
    );

    const positions = {
      top: "main_w-overlay_w-20:20",
      center: "(main_w-overlay_w)/2:(main_h-overlay_h)/2",
      bottom: "(main_w-overlay_w)/2:main_h-overlay_h-20",
      topleft: "20:20",
      topright: "main_w-overlay_w-20:20",
      bottomleft: "20:main_h-overlay_h-20",
      bottomright: "main_w-overlay_w-20:main_h-overlay_h-20"
    };

    const overlayPosition = positions[position] || positions.center;

    const outputName = `sticker_${Date.now()}.mp4`;
    const outputPath = path.join(outputDir, outputName);

    const stickerFilter =
      `[1:v]scale=w='trunc(${size}/2)*2':h='trunc(ih*${size}/iw/2)*2',format=rgba,colorchannelmixer=aa=${opacity}[sticker];` +
      `[0:v][sticker]overlay=${overlayPosition}:format=auto[v]`;

    execFile(
      "ffmpeg",
      [
        "-y",

        "-i",
        video.path,

        "-i",
        sticker.path,

        "-filter_complex",
        stickerFilter,

        "-map",
        "[v]",

        "-map",
        "0:a?",

        "-c:v",
        "libx264",

        "-preset",
        "veryfast",

        "-crf",
        "26",

        "-pix_fmt",
        "yuv420p",

        "-c:a",
        "aac",

        "-shortest",

        outputPath
      ],
      (error, stdout, stderr) => {

        if (error) {

          console.error("Sticker FFmpeg error:", stderr);

          return res.status(500).json({
            success: false,
            message: "Failed to add sticker",
            error: stderr || error.message
          });

        }

        return res.json({
          success: true,
          message: "Sticker added successfully",
          url: `/outputs/${outputName}`
        });

      }
    );

  } catch (error) {

    console.error("Sticker error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Server error"
    });

  }

});

// ============================
// ============================
// Video Animation
// ============================

// ============================

app.post("/api/video/animation", musicUpload.single("video"), (req, res) => {

  try {

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Video is required"
      });
    }

    const animation = String(req.body.animation || "none");

    const duration = Math.max(
      0.5,
      Math.min(10, Number(req.body.duration || 1))
    );

    const timestamp = Date.now();
    const outputName = `animation_${timestamp}.mp4`;
    const outputPath = path.join(outputDir, outputName);

    let videoFilter = null;

    switch (animation) {

      case "fadein":
        videoFilter = `fade=t=in:st=0:d=1:alpha=0`;
        break;

      case "fadeout":
        videoFilter = `fade=t=out:st=0:d=${duration}`;
        break;

      case "zoomin":
        {
          const probe = spawnSync("ffprobe", [
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=s=x:p=0",
            req.file.path
          ], { encoding: "utf8" });

          const [videoWidth, videoHeight] = probe.stdout.trim()
            .split("x")
            .map(Number);

          if (!videoWidth || !videoHeight) {
            return res.status(500).json({
              success: false,
              message: "Could not detect video dimensions"
            });
          }

          const d = duration;

          videoFilter =
            `scale=trunc(iw*(1+2*min(t/${d}\\,1))/2)*2:` +
            `trunc(ih*(1+2*min(t/${d}\\,1))/2)*2:eval=frame,` +
            `crop=${videoWidth}:${videoHeight}:` +
            `x='(iw-${videoWidth})/2':` +
            `y='(ih-${videoHeight})/2'`;
        }
        break;

      case "zoomout":
        {
          const probe = spawnSync("ffprobe", [
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=s=x:p=0",
            req.file.path
          ], { encoding: "utf8" });

          const [videoWidth, videoHeight] = probe.stdout.trim()
            .split("x")
            .map(Number);

          if (!videoWidth || !videoHeight) {
            return res.status(500).json({
              success: false,
              message: "Could not detect video dimensions"
            });
          }

          const d = duration;

          videoFilter =
            `scale=trunc(iw*(3-2*min(t/${d}\\,1))/2)*2:` +
            `trunc(ih*(3-2*min(t/${d}\\,1))/2)*2:eval=frame,` +
            `crop=${videoWidth}:${videoHeight}:` +
            `x='(iw-${videoWidth})/2':` +
            `y='(ih-${videoHeight})/2'`;
        }
        break;

      case "slideleft":
        videoFilter =
          `scale=2560:1440,` +
          `crop=1280:720:` +
          `x='1280*(1-min(t/1\\,1))':` +
          `y=360`;
        break;

      case "slideright":
        videoFilter =
          `scale=2560:1440,` +
          `crop=1280:720:` +
          `x='1280*min(t/1\\,1)':` +
          `y=360`;
        break;

      case "slideup":
        videoFilter =
          `scale=2560:1440,` +
          `crop=1280:720:` +
          `x=640:` +
          `y='720*(1-min(t/1\\,1))'`;
        break;

      case "slidedown":
        videoFilter =
          `scale=2560:1440,` +
          `crop=1280:720:` +
          `x=640:` +
          `y='720*min(t/1\\,1)'`;
        break;

      case "rotate":
        videoFilter =
          `rotate='2*PI*t/${duration}':` +
          `fillcolor=black,` +
          `scale=trunc(iw/2)*2:trunc(ih/2)*2`;
        break;

      case "shake":
        videoFilter =
          "crop=iw-50:ih-50:" +
          "25+15*sin(18*t):" +
          "25+15*cos(21*t)";
        break;

      case "none":
      default:
        videoFilter = null;
        break;
    }

    const args = [
      "-y",
      "-i",
      req.file.path
    ];

    if (videoFilter) {
      args.push(
        "-vf",
        videoFilter
      );
    }

    args.push(
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "28",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      outputPath
    );

    console.log("🎬 ANIMATION:", animation);
    console.log("🎬 DURATION:", duration);
    console.log("🎬 FILTER:", videoFilter);

    execFile(
      "ffmpeg",
      args,
      (error, stdout, stderr) => {

        fs.unlink(req.file.path, () => {});

        if (error) {

          console.error(
            "FFMPEG ANIMATION ERROR:",
            stderr || error.message
          );

          if (fs.existsSync(outputPath)) {
            fs.unlink(outputPath, () => {});
          }

          return res.status(500).json({
            success: false,
            message: "Animation processing failed"
          });
        }

        return res.json({
          success: true,
          message: "Animation applied successfully",
          videoUrl: `/outputs/${outputName}`
        });
      }
    );

  } catch (error) {

    console.error("ANIMATION SERVER ERROR:", error);

    if (req.file) {
      fs.unlink(req.file.path, () => {});
    }

    return res.status(500).json({
      success: false,
      message: "Animation server error"
    });
  }

});




// ============================
// YouTube Automation - Generate Scene Images
// ============================
app.post("/api/youtube/generate-images", async (req, res) => {
  try {
    const { scenes } = req.body || {};

    if (!Array.isArray(scenes) || scenes.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Scenes array is required"
      });
    }

    const safeScenes = scenes.slice(0, 50);

    const sceneDir = path.join(outputDir, "youtube-scenes");

    if (!fs.existsSync(sceneDir)) {
      fs.mkdirSync(sceneDir, { recursive: true });
    }

    const results = [];

    for (const scene of safeScenes) {
      if (!scene?.prompt) {
        continue;
      }

      const sceneNumber = parseInt(scene.scene) || (results.length + 1);

      const encodedPrompt = encodeURIComponent(
        String(scene.prompt).trim()
      );

      const imageUrl =
        `https://image.pollinations.ai/prompt/${encodedPrompt}` +
        `?width=1280&height=720&nologo=true`;

      let imageBuffer = null;
      let lastError = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          console.log(`🖼️ Generating YouTube scene ${sceneNumber} (attempt ${attempt}/3)`);

          const response = await fetch(imageUrl);

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          imageBuffer = Buffer.from(await response.arrayBuffer());

          if (!imageBuffer.length) {
            throw new Error("Empty image response");
          }

          console.log(`✅ YouTube scene image ${sceneNumber} generated`);
          break;

        } catch (error) {
          lastError = error;
          console.error(`⚠️ Scene ${sceneNumber} attempt ${attempt} failed:`, error.message);

          if (attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        }
      }

      if (!imageBuffer) {
        throw new Error(
          `Image generation failed for scene ${sceneNumber} after 3 attempts: ${lastError?.message || "Unknown error"}`
        );
      }

      const filename = `scene-${sceneNumber}.jpg`;
      const filepath = path.join(sceneDir, filename);

      fs.writeFileSync(filepath, imageBuffer);

      results.push({
        scene: sceneNumber,
        summary: scene.summary || "",
        prompt: scene.prompt,
        duration: Number(scene.duration) || 8,
        imageUrl: `/outputs/youtube-scenes/${filename}`
      });

      console.log(`✅ YouTube scene image ${sceneNumber} saved`);
    }

    res.json({
      success: true,
      sceneCount: results.length,
      images: results
    });

  } catch (error) {
    console.error("❌ YouTube scene images error:", error);

    res.status(500).json({
      success: false,
      message: error?.message || "Scene image generation failed"
    });
  }
});


// ============================
// ============================
// YouTube Automation - Create Video from Scene Images
// ============================
app.post("/api/youtube/create-video", async (req, res) => {
  let workDir = null;

  try {
    const { scenes, voiceText, voice = "ur-PK-UzmaNeural" } = req.body || {};

    if (!Array.isArray(scenes) || scenes.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Scenes are required"
      });
    }

    const safeScenes = scenes.slice(0, 50);
    const sceneDir = path.join(outputDir, "youtube-scenes");
    workDir = path.join(outputDir, `youtube-work-${Date.now()}`);

    if (!fs.existsSync(sceneDir)) {
      return res.status(400).json({
        success: false,
        message: "Scene images directory not found"
      });
    }

    fs.mkdirSync(workDir, { recursive: true });

    const segments = [];

    for (let i = 0; i < safeScenes.length; i++) {
      const scene = safeScenes[i];
      const sceneNumber = parseInt(scene.scene);

      if (!sceneNumber) continue;

      const imagePath = path.join(
        sceneDir,
        `scene-${sceneNumber}.jpg`
      );

      if (!fs.existsSync(imagePath)) {
        throw new Error(
          `Scene image not found: scene-${sceneNumber}.jpg`
        );
      }

      const duration = Math.max(
        1,
        Math.min(Number(scene.duration) || 8, 60)
      );

      const segmentPath = path.join(
        workDir,
        `segment-${i + 1}.mp4`
      );

      console.log(
        `🎬 Creating scene ${sceneNumber}: ${duration}s`
      );

      const result = spawnSync(
        "ffmpeg",
        [
          "-y",
          "-loop", "1",
          "-i", imagePath,
          "-t", String(duration),

          "-vf",
          "scale=1280:720:force_original_aspect_ratio=decrease," +
          "pad=1280:720:(ow-iw)/2:(oh-ih)/2," +
          "format=yuv420p",

          "-r", "30",
          "-c:v", "libx264",
          "-profile:v", "baseline",
          "-level", "3.1",
          "-preset", "veryfast",
          "-crf", "23",
          "-pix_fmt", "yuv420p",
          "-an",
          "-movflags", "+faststart",

          segmentPath
        ],
        {
          encoding: "utf8"
        }
      );

      if (result.status !== 0) {
        console.error(
          "FFmpeg scene error:",
          result.stderr
        );

        throw new Error(
          `Failed to create scene ${sceneNumber}`
        );
      }

      segments.push(segmentPath);
    }

    if (segments.length === 0) {
      throw new Error(
        "No valid scene segments created"
      );
    }

    const listPath = path.join(
      workDir,
      "segments.txt"
    );

    const concatList = segments
      .map(file => {
        const safe = file.replace(/'/g, "'\\''");
        return `file '${safe}'`;
      })
      .join("\n");

    fs.writeFileSync(
      listPath,
      concatList
    );

    const silentVideoPath = path.join(
      workDir,
      "silent-video.mp4"
    );

    console.log(
      "🎬 Combining scene segments..."
    );

    const finalResult = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,

        "-c:v", "libx264",
        "-profile:v", "baseline",
        "-level", "3.1",
        "-preset", "veryfast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-r", "30",
        "-an",
        "-movflags", "+faststart",

        silentVideoPath
      ],
      {
        encoding: "utf8"
      }
    );

    if (finalResult.status !== 0) {
      console.error(
        "Final FFmpeg error:",
        finalResult.stderr
      );

      throw new Error(
        "Final video encoding failed"
      );
    }

    /*
     * ============================
     * Generate AI Voice
     * ============================
     */

    const text =
      typeof voiceText === "string" &&
      voiceText.trim()
        ? voiceText.trim()
        : safeScenes
            .map(scene => scene.summary || "")
            .filter(Boolean)
            .join(" ");

    if (!text) {
      throw new Error(
        "Voice text is required"
      );
    }

    const safeVoice = [
      "ur-PK-UzmaNeural",
      "ur-PK-AsadNeural"
    ].includes(voice)
      ? voice
      : "ur-PK-UzmaNeural";

    const voicePath = path.join(
      workDir,
      "youtube_voice.mp3"
    );

    console.log(
      "🎙️ Generating Urdu AI voice..."
    );

    const voiceProcess = spawnSync(
      "python",
      [
        "-m",
        "edge_tts",
        "--voice",
        safeVoice,
        "--text",
        text,
        "--write-media",
        voicePath
      ],
      {
        encoding: "utf8"
      }
    );

    if (
      voiceProcess.status !== 0 ||
      !fs.existsSync(voicePath)
    ) {
      console.error(
        "Edge TTS error:",
        voiceProcess.stderr
      );

      throw new Error(
        "Voice generation failed"
      );
    }

    /*
     * ============================
     * Merge Video + Voice
     * ============================
     */

    const outputName =
      `youtube_final_${Date.now()}.mp4`;

    const outputPath =
      path.join(outputDir, outputName);

    console.log(
      "🎬🎙️ Merging video and AI voice..."
    );

    const mergeResult = spawnSync(
      "ffmpeg",
      [
        "-y",

        "-i", silentVideoPath,
        "-i", voicePath,

        "-map", "0:v:0",
        "-map", "1:a:0",

        "-c:v", "libx264",
        "-profile:v", "baseline",
        "-level", "3.1",
        "-preset", "veryfast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-r", "30",

        "-c:a", "aac",
        "-profile:a", "aac_low",
        "-b:a", "128k",
        "-ar", "44100",
        "-ac", "2",

        "-shortest",
        "-movflags", "+faststart",

        outputPath
      ],
      {
        encoding: "utf8"
      }
    );

    if (
      mergeResult.status !== 0 ||
      !fs.existsSync(outputPath)
    ) {
      console.error(
        "Video + voice FFmpeg error:",
        mergeResult.stderr
      );

      throw new Error(
        "Video and voice merge failed"
      );
    }

    /*
     * Cleanup
     */

    try {
      fs.rmSync(
        workDir,
        {
          recursive: true,
          force: true
        }
      );
    } catch (cleanupError) {
      console.error(
        "Cleanup warning:",
        cleanupError.message
      );
    }

    res.json({
      success: true,
      message:
        "YouTube video with AI voice created successfully",
      videoUrl:
        `/outputs/${outputName}`,
      voice:
        safeVoice
    });

  } catch (error) {

    console.error(
      "❌ YOUTUBE CREATE VIDEO ERROR:",
      error
    );

    if (workDir) {
      try {
        fs.rmSync(
          workDir,
          {
            recursive: true,
            force: true
          }
        );
      } catch {}
    }

    res.status(500).json({
      success: false,
      message:
        error?.message ||
        "Video creation failed"
    });
  }
});


// ============================
// Safepay Webhook
// ============================
const crypto = require("crypto");

app.post("/api/payment/safepay/webhook", (req, res) => {
  try {
    const signature = req.headers["x-sfpy-signature"];
    const timestamp = req.headers["x-sfpy-timestamp"];
    const secret = process.env.SAFEPAY_WEBHOOK_SECRET;
    const rawBody = req.rawBody;

    if (!signature || !timestamp || !secret || !rawBody) {
      console.error("❌ Safepay webhook verification data missing");
      return res.status(400).send("Invalid webhook request");
    }

    // Safepay signature:
    // HMAC-SHA256(base64-decoded-secret, timestamp + "." + raw body)
    const key = Buffer.from(secret, "base64");

    const hmac = crypto.createHmac("sha256", key);
    hmac.update(String(timestamp));
    hmac.update(".");
    hmac.update(rawBody);

    const expectedSignature =
      "sha256=" + hmac.digest("hex");

    const provided = Buffer.from(String(signature));
    const expected = Buffer.from(expectedSignature);

    if (
      provided.length !== expected.length ||
      !crypto.timingSafeEqual(provided, expected)
    ) {
      console.error("❌ Safepay webhook signature invalid");
      return res.status(401).send("Invalid signature");
    }

    const event = req.body || {};

    console.log(
      "✅ Safepay webhook verified:",
      JSON.stringify(event, null, 2)
    );

    // IMPORTANT:
    // For now we only verify and log the event.
    // We will activate the user's plan after confirming
    // the exact Sandbox payment.completed payload.

    return res.status(200).send("OK");

  } catch (error) {
    console.error(
      "❌ Safepay webhook error:",
      error?.message || error
    );

    return res.status(500).send("Webhook processing failed");
  }
});

// ============================
// Safepay Sandbox Payments
// ============================

const Safepay = require("@sfpy/node-core");

const safepay = Safepay(process.env.SAFEPAY_SECRET_KEY, {
  authType: "secret",
  host: process.env.SAFEPAY_BASE_URL || "https://sandbox.api.getsafepay.com"
});

app.post("/api/payment/safepay/create", async (req, res) => {
  try {
    const { plan } = req.body;

    const plans = {
      monthly: {
        amount: 999,
        name: "Aventra Pro Monthly"
      },
      annual: {
        amount: 9999,
        name: "Aventra Pro Annual"
      }
    };

    const selectedPlan = plans[plan];

    if (!selectedPlan) {
      return res.status(400).json({
        success: false,
        message: "Invalid plan"
      });
    }

    const orderId =
      `AVENTRA-${plan.toUpperCase()}-${Date.now()}`;

    // 1. Create fresh Safepay payment tracker
    const response =
      await safepay.payments.session.setup({
        merchant_api_key:
          process.env.SAFEPAY_PUBLIC_KEY,
        intent: "CYBERSOURCE",
        mode: "payment",
        entry_mode: "raw",
        currency: "USD",
        amount: selectedPlan.amount,
        metadata: {
          order_id: orderId
        }
      });

    const tracker =
      response?.data?.tracker;

    if (!tracker?.token) {
      throw new Error(
        "Safepay tracker token not received"
      );
    }

    // 2. Get fresh Passport token (TBT)
    const passport =
      await safepay.client.passport.create({});

    const tbt = passport?.data;

    if (!tbt) {
      throw new Error(
        "Safepay passport token not received"
      );
    }

    // 3. Create authenticated checkout URL
    const checkoutUrl =
      safepay.checkout.createCheckoutUrl({
        env: "sandbox",
        tbt,
        tracker: tracker.token,
        source: "hosted",
        order_id: orderId,
        cancel_url:
          "http://localhost:3000/",
        redirect_url:
          "http://localhost:3000/",
        webhooks: true
      });

    console.log(
      `✅ Safepay ${plan} checkout created`
    );

    res.json({
      success: true,
      plan,
      amount: selectedPlan.amount,
      checkoutUrl
    });

  } catch (error) {
    console.error(
      "❌ Safepay payment error:",
      error?.response?.data ||
      error?.message ||
      error
    );

    res.status(500).json({
      success: false,
      message:
        error?.message ||
        "Safepay payment creation failed"
    });
  }
});

app.listen(PORT, async () => {
  try {
    await initDatabase();
    console.log(`Aventra Video Studio running on port ${PORT}`);
  } catch (error) {
    console.error("❌ Database initialization failed:", error);
  }
});
