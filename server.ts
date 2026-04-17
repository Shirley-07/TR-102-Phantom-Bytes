import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import twilio from "twilio";
import webpush from "web-push";
import { calculateSafetyScore, generateMultilingualAlert, generateFishingAdvice } from "./aiService";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || "fallback-secret-for-dev";

// Twilio Setup (Lazy Init)
let twilioClient: any = null;

const getTwilioClient = () => {
  if (twilioClient) return twilioClient;
  
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  
  if (sid && token && sid.trim() !== "" && sid.startsWith("AC")) {
    try {
      twilioClient = twilio(sid, token);
      return twilioClient;
    } catch (error) {
      console.error("Twilio Initialization Error:", error);
      return null;
    }
  }
  return null;
};

const sendSMSAlert = async (to: string, message: string) => {
  const client = getTwilioClient();
  if (!client || !process.env.TWILIO_PHONE_NUMBER) {
    console.warn("Twilio not configured properly. SOS/Danger SMS not sent.");
    return;
  }
  try {
    await client.messages.create({
      body: `🚨 SEASAFE ALERT: ${message}`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: to
    });
    console.log(`Alert SMS sent to ${to}`);
  } catch (error) {
    console.error("Failed to send Twilio SMS:", error);
  }
};

// Web Push Setup
const setupWebPush = () => {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  let subject = process.env.VAPID_SUBJECT || "mailto:sreenithya046@gmail.com";

  if (publicKey && privateKey) {
    if (!subject.startsWith('mailto:') && !subject.startsWith('http')) {
      subject = "mailto:sreenithya046@gmail.com";
    }

    try {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      console.log("✅ Web Push configured successfully.");
    } catch (error) {
      console.error("❌ Failed to set Vapid Details:", error);
    }
  } else {
    console.warn("⚠️ Web Push keys missing (Public/Private)");
  }
};

setupWebPush();

const sendPushAlert = async (userId: string, title: string, body: string) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user?.pushSubscription) {
      const subscription = user.pushSubscription as any;
      console.log(`Attempting to send push to user ${userId}...`);
      await webpush.sendNotification(
        subscription,
        JSON.stringify({ title, body, url: '/' })
      );
      console.log(`✅ Push notification sent successfully to ${userId}`);
    } else {
      console.warn(`⚠️ User ${userId} has no push subscription stored.`);
    }
  } catch (error) {
    console.error("❌ Failed to send Push Notification:", error);
    if ((error as any).statusCode === 410 || (error as any).statusCode === 404) {
      console.log(`Removing expired subscription for ${userId}`);
      await prisma.user.update({
        where: { id: userId },
        data: { pushSubscription: null }
      });
    }
  }
};

// Auth Middleware
const authenticateToken = (req: any, res: any, next: any) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: "Access denied" });

  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) return res.status(403).json({ error: "Invalid token" });
    req.user = user;
    next();
  });
};

// Middleware to verify Admin role
const isAdmin = (req: any, res: any, next: any) => {
  if (req.user && req.user.role === 'ADMIN') {
    next();
  } else {
    res.status(403).json({ error: "Unauthorized: Administrator access required" });
  }
};

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // --- PUBLIC API ROUTES ---

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Auth: Register
  app.post("/api/auth/register", async (req, res) => {
    const { email, password, name, phone } = req.body;
    try {
      const userCount = await prisma.user.count();
      // First user is automatically an ADMIN, others are FISHERMAN
      const role = userCount === 0 ? 'ADMIN' : 'FISHERMAN';
      
      const hashedPassword = await bcrypt.hash(password, 10);
      const user = await prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          name,
          phoneNumber: phone,
          role: role
        }
      });
      const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET);
      res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
    } catch (error) {
      console.error("Registration error:", error);
      res.status(400).json({ error: "User already exists or invalid data" });
    }
  });

  // Auth: Login
  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    try {
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) return res.status(404).json({ error: "User not found" });

      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) return res.status(401).json({ error: "Invalid password" });

      const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET);
      res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
    } catch (error) {
      res.status(500).json({ error: "Login failed" });
    }
  });

  // Marine Weather Proxy (Open-Meteo)
  app.get("/api/weather", async (req, res) => {
    const { lat, lon } = req.query;
    if (!lat || !lon) {
      return res.status(400).json({ error: "Latitude and Longitude are required" });
    }

    try {
      // DEMO OVERRIDE: If the user picks the High-Risk Zone (15.0, 88.0), force extreme weather
      const isHighRiskZone = parseFloat(lat as string) === 15.0 && parseFloat(lon as string) === 88.0;

      const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&current=wave_height,wave_direction,wave_period,wind_wave_height&hourly=wave_height,wave_direction,wave_period&daily=wave_height_max,wave_direction_dominant,wave_period_max&timezone=auto`;
      const response = await fetch(url);
      const data = await response.json();
      
      const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility&hourly=temperature_2m,wind_speed_10m,visibility&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_sum,rain_sum,showers_sum,snowfall_sum,precipitation_hours,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant&timezone=auto`;
      const weatherResponse = await fetch(weatherUrl);
      const weatherData = await weatherResponse.json();

      if (isHighRiskZone && data.current) {
        // Inject extreme values for demo
        data.current.wave_height = 8.5; // Massive waves
        weatherData.current.wind_speed_10m = 120.0; // Cyclone force
        weatherData.current.wind_gusts_10m = 160.0;
        weatherData.current.weather_code = 95; // Thunderstorm
      }

      res.json({ marine: data, weather: weatherData });
    } catch (error) {
      console.error("Weather fetch error:", error);
      res.status(500).json({ error: "Failed to fetch weather data" });
    }
  });

  // --- PROTECTED API ROUTES ---

  // Get Current User Profile
  app.get("/api/auth/me", authenticateToken, async (req: any, res) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { id: true, email: true, name: true, role: true, phoneNumber: true }
      });
      res.json(user);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch user profile" });
    }
  });

  // Get all users (Admin only)
  app.get("/api/admin/users", authenticateToken, isAdmin, async (req, res) => {
    try {
      const users = await prisma.user.findMany({
        select: {
          id: true,
          email: true,
          name: true,
          phoneNumber: true,
          role: true,
          baseZone: true,
          createdAt: true
        },
        orderBy: { createdAt: 'desc' }
      });
      res.json(users);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  // --- HAZARD ROUTES (Sea-Waze) ---

  // Report a Hazard
  app.post("/api/hazards", authenticateToken, async (req: any, res) => {
    const { type, description, lat, lon } = req.body;
    try {
      const hazard = await prisma.hazard.create({
        data: {
          userId: req.user.id,
          type,
          description,
          lat,
          lon,
          expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000) // 48h expiry
        }
      });
      res.json(hazard);
    } catch (error) {
      console.error("Hazard reporting error:", error);
      res.status(500).json({ error: "Failed to report hazard" });
    }
  });

  // Get Active Hazards
  app.get("/api/hazards", async (req, res) => {
    try {
      const hazards = await prisma.hazard.findMany({
        where: {
          expiresAt: { gt: new Date() }
        },
        orderBy: { createdAt: 'desc' },
        take: 50
      });
      res.json(hazards);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch hazards" });
    }
  });

  // Log SOS Signal
  app.post("/api/sos", authenticateToken, async (req: any, res) => {
    const { lat, lon, message, zoneName } = req.body;
    try {
      const signal = await prisma.sOSSignal.create({
        data: {
          userId: req.user.id,
          lat,
          lon,
          message,
          zoneName,
          status: 'PENDING'
        }
      });
      res.json(signal);
    } catch (error) {
      console.error("SOS Signal error:", error);
      res.status(500).json({ error: "Failed to log SOS signal" });
    }
  });

  // Get SOS History (For Admins/Coast Guard)
  app.get("/api/admin/sos", authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'ADMIN' && req.user.role !== 'COAST_GUARD') {
      return res.status(403).json({ error: "Unauthorized" });
    }
    try {
      const signals = await prisma.sOSSignal.findMany({
        include: { user: { select: { name: true, phoneNumber: true } } },
        orderBy: { createdAt: 'desc' }
      });
      res.json(signals);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch SOS signals" });
    }
  });

  // --- AI ENDPOINTS ---
  
  app.post("/api/ai/analyze", authenticateToken, async (req, res) => {
    const { weatherData, zoneName } = req.body;
    try {
      const safetyScore = await calculateSafetyScore(weatherData);
      const alerts = await generateMultilingualAlert(safetyScore, zoneName);
      const fishingAdvice = await generateFishingAdvice(weatherData);
      
      res.json({ safetyScore, alerts, fishingAdvice });
    } catch (error) {
      console.error("AI Analysis API Error:", error);
      res.status(500).json({ error: "AI analysis failed" });
    }
  });

  // Save AI Safety Report
  app.post("/api/safety-reports", authenticateToken, async (req: any, res) => {
    const { zoneId, zoneName, score, level, recommendation, reasoning, safeReturnTime, confidence } = req.body;
    try {
      const report = await prisma.safetyReport.create({
        data: {
          userId: req.user.id,
          zoneId,
          zoneName,
          score,
          level,
          recommendation,
          reasoning,
          safeReturnTime,
          confidence
        }
      });

      // TRIGGER SMS ALERT IF DANGEROUS
      if (level === 'DANGER' || level === 'CYCLONE') {
        const user = await prisma.user.findUnique({ where: { id: req.user.id } });
        const alertMsg = `🚨 DANGER in ${zoneName}! Score: ${score}/100. Recommendation: ${recommendation}. Please return to shore immediately.`;
        
        // Send SMS
        if (user?.phoneNumber) {
          await sendSMSAlert(user.phoneNumber, alertMsg);
        }

        // Send App Push Notification
        await sendPushAlert(req.user.id, `🚨 SEASAFE DANGER: ${zoneName}`, alertMsg);
      }

      res.json(report);
    } catch (error) {
      res.status(500).json({ error: "Failed to save safety report" });
    }
  });

  // Get Safety History
  app.get("/api/safety-reports", authenticateToken, async (req: any, res) => {
    try {
      const reports = await prisma.safetyReport.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
        take: 10
      });
      res.json(reports);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch safety history" });
    }
  });

  // Handle Push Subscription
  app.post("/api/notifications/subscribe", authenticateToken, async (req: any, res) => {
    const subscription = req.body;
    try {
      await prisma.user.update({
        where: { id: req.user.id },
        data: { pushSubscription: subscription }
      });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to save subscription" });
    }
  });

  // Get VAPID Status
  app.get("/api/notifications/vapid-key", (req, res) => {
    res.json({ 
      publicKey: process.env.VAPID_PUBLIC_KEY || "",
      isServerConfigured: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
    });
  });

  // --- VITE / STATIC SERVING ---
  const distPath = path.join(__dirname, "dist");

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    
    // Serve index.html as a fallback for the SPA in dev
    app.get("*", async (req, res, next) => {
      const url = req.originalUrl;
      // Skip API routes
      if (url.startsWith("/api")) return next();
      
      try {
        let template = fs.readFileSync(path.resolve(__dirname, "index.html"), "utf-8");
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ "Content-Type": "text/html" }).end(template);
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    });
  } else {
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
