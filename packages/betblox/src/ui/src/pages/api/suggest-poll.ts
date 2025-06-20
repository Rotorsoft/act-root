import type { NextApiRequest, NextApiResponse } from "next";
import { OpenAI } from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const prompt = `
    Suggest a poll about a current event in sports, politics, or pop culture.
    Respond as JSON: { "question": "...", "options": ["...", "...", "..."] }
  `;
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
      temperature: 0.8,
    });
    const text = completion.choices[0].message.content || "";
    const json = JSON.parse(text);
    res.status(200).json(json);
  } catch (err) {
    res.status(500).json({
      error: "Failed to get or parse AI response",
      details: String(err),
    });
  }
}
