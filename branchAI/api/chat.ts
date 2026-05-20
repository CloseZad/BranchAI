import { GoogleGenAI, type Content } from '@google/genai'

type ChatMessage = {
  role: 'user' | 'model'
  text: string
}

type JsonResponse = {
  status: (code: number) => JsonResponse
  json: (body: unknown) => void
  setHeader: (name: string, value: string) => void
}

type JsonRequest = {
  method?: string
  body?: {
    message?: string
    history?: ChatMessage[]
  }
}

const allowedOrigins = new Set([
  'https://closezad.design',
  'https://www.closezad.design',
])

function toGeminiHistory(history: ChatMessage[]): Content[] {
  return history.map((message) => ({
    role: message.role,
    parts: [{ text: message.text }],
  }))
}

function setCors(req: { headers?: { origin?: string } }, res: JsonResponse) {
  const origin = req.headers?.origin

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }

  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

export default async function handler(req: JsonRequest, res: JsonResponse) {
  setCors(req, res)

  if (req.method === 'OPTIONS') {
    res.status(204).json({})
    return
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY
    const message = req.body?.message?.trim()

    if (!apiKey) {
      res.status(500).json({ error: 'Missing GEMINI_API_KEY.' })
      return
    }

    if (!message) {
      res.status(400).json({ error: 'Message is required.' })
      return
    }

    const ai = new GoogleGenAI({ apiKey })
    const chat = ai.chats.create({
      model: 'gemini-2.5-flash',
      history: toGeminiHistory(req.body?.history ?? []),
    })
    const response = await chat.sendMessage({ message })

    res.status(200).json({ text: response.text ?? '' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Gemini error.'
    res.status(500).json({ error: message })
  }
}
