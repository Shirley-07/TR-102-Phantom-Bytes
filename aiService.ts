import { GoogleGenAI, Type } from "@google/genai";
import { WeatherData, SafetyScore, FishingAdvice } from "./src/types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export async function calculateSafetyScore(weatherData: WeatherData): Promise<SafetyScore> {
  const prompt = `
    Analyze the following marine weather data for a coastal fishing zone in India and provide a safety risk assessment for small-scale fishermen.
    
    Current Marine Data:
    - Wave Height: ${weatherData.marine.current.wave_height}m
    - Wave Direction: ${weatherData.marine.current.wave_direction}°
    - Wave Period: ${weatherData.marine.current.wave_period}s
    
    Current Weather Data:
    - Wind Speed (10m): ${weatherData.weather.current.wind_speed_10m}km/h
    - Wind Gusts: ${weatherData.weather.current.wind_gusts_10m}km/h
    - Visibility: ${weatherData.weather.current.visibility}m
    - Weather Code: ${weatherData.weather.current.weather_code} (WMO code)
    - Precipitation: ${weatherData.weather.current.precipitation}mm
    
    Daily Forecast:
    - Max Wind Speed: ${weatherData.weather.daily.wind_speed_10m_max[0]}km/h
    - Max Wave Height: ${weatherData.marine.daily.wave_height_max[0]}m
    - Precipitation Probability: ${weatherData.weather.daily.precipitation_probability_max[0]}%
    
    Output the assessment in JSON format with the following structure:
    {
      "score": number (0-100, where 100 is most dangerous),
      "level": "SAFE" | "ADVISORY" | "DANGER" | "CYCLONE",
      "confidence": number (0-100),
      "recommendation": string (Clear fisherman-friendly advice like "Today Safe to Fish", "Delay Departure", "Return Early", "Do Not Go to Sea"),
      "reasoning": string[] (List of specific risk factors identified),
      "safeReturnTime": string (Estimated safest return window, e.g., "Before 2:45 PM")
    }
  `;

  try {
    const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
    const response = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
      }
    });

    const result = JSON.parse(response.response.text());
    return result;
  } catch (error) {
    console.error("Gemini safety score error:", error);
    // Fallback logic
    const wind = weatherData.weather.current.wind_speed_10m;
    const wave = weatherData.marine.current.wave_height;
    let score = (wind * 2) + (wave * 20);
    score = Math.min(100, score);
    
    let level: any = "SAFE";
    if (score > 70) level = "DANGER";
    else if (score > 40) level = "ADVISORY";

    return {
      score,
      level,
      confidence: 80,
      recommendation: level === "SAFE" ? "Today Safe to Fish" : level === "ADVISORY" ? "Delay Departure" : "Do Not Go to Sea",
      reasoning: ["Calculated using standard marine safety thresholds (Fallback)."],
      safeReturnTime: "Before Sunset"
    };
  }
}

export async function generateMultilingualAlert(safetyScore: SafetyScore, zoneName: string) {
  const prompt = `
    Generate a short, urgent weather safety alert for fishermen in ${zoneName}.
    The current safety level is ${safetyScore.level} with a risk score of ${safetyScore.score}/100.
    Recommendation: ${safetyScore.recommendation}.
    Reasoning: ${safetyScore.reasoning.join(", ")}.
    
    Provide the alert in the following languages:
    - English
    - Tamil
    - Malayalam
    - Telugu
    - Odia
    - Hindi
    
    Output as JSON:
    {
      "en": "...",
      "ta": "...",
      "ml": "...",
      "te": "...",
      "or": "...",
      "hi": "..."
    }
  `;

  try {
    const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
    const response = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
      }
    });
    return JSON.parse(response.response.text());
  } catch (error) {
    console.error("Gemini multilingual alert error:", error);
    return {
      en: `Safety Alert for ${zoneName}: ${safetyScore.recommendation}. Risk Score: ${safetyScore.score}.`,
      ta: `${zoneName} க்கான பாதுகாப்பு எச்சரிக்கை: ${safetyScore.recommendation}.`,
      ml: `${zoneName} സുരക്ഷാ മുന്നറിയിപ്പ്: ${safetyScore.recommendation}.`,
      te: `${zoneName} భద్రతా హెచ్చరిక: ${safetyScore.recommendation}.`,
      or: `${zoneName} ପାଇଁ ସୁରକ୍ଷା ସତর୍କତା: ${safetyScore.recommendation}.`,
      hi: `${zoneName} के लिए सुरक्षा चेतावनी: ${safetyScore.recommendation}.`
    };
  }
}

export async function generateFishingAdvice(weatherData: WeatherData): Promise<FishingAdvice> {
  const prompt = `
    Based on the following marine weather data, provide smart fishing advice for coastal Indian fisherfolk.
    
    Data:
    - Wave Height: ${weatherData.marine.current.wave_height}m
    - Wind Speed: ${weatherData.weather.current.wind_speed_10m}km/h
    - Temperature: ${weatherData.weather.current.temperature_2m}°C
    - Precipitation: ${weatherData.weather.current.precipitation}mm
    - Cloud Cover: ${weatherData.weather.current.cloud_cover}%
    
    Provide:
    1. Best time to fish today.
    2. Suggested fishing depth.
    3. Recommended gear/techniques.
    4. AI Reasoning (why these suggestions).
    5. A 1-sentence summary in English, Tamil, Malayalam, Telugu, and Hindi.
    
    Output JSON:
    {
      "bestTime": "string",
      "suggestedDepth": "string",
      "bestGear": "string",
      "aiReasoning": "string",
      "localizedSummary": {
        "en": "...",
        "ta": "...",
        "ml": "...",
        "te": "...",
        "hi": "..."
      }
    }
  `;

  try {
    const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
    const response = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
      }
    });
    return JSON.parse(response.response.text());
  } catch (error) {
    console.error("Gemini fishing advice error:", error);
    return {
      bestTime: "Early Morning (4 AM - 8 AM)",
      suggestedDepth: "Mid-level (10m - 20m)",
      bestGear: "Handlines or Cast Nets",
      aiReasoning: "Moderate weather allows for stable near-shore fishing.",
      localizedSummary: {
        en: "Good conditions for near-shore fishing today.",
        ta: "இன்று கரைக்கு அருகிலுள்ள மீன்பிடிக்க நல்ல சூழல்.",
        ml: "തീരത്തിനടുത്തുള്ള മീൻപിടുത്തത്തിന് இன்று നല്ല സാഹചര്യമാണ്.",
        te: "తీరానికి సమీపంలో చేపల వేటకు నేడు మంచి పరిస్థితులు ఉన్నాయి.",
        hi: "आज किनारे के पास मछली पकड़ने के लिए अच्छी स्थिति है।"
      }
    };
  }
}
