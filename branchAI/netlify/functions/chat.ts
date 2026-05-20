import { GoogleGenAI, type Content } from '@google/genai'

type ChatMessage = {
  role: 'user' | 'model'
  text: string
}

type ChatRequestBody = {
  message?: string
  history?: ChatMessage[]
}

const allowedOrigins = new Set([
  'https://closezad.design',
  'https://www.closezad.design',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
])

function corsHeaders(request: Request) {
  const origin = request.headers.get('origin')
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    Vary: 'Origin',
  }

  if (origin && allowedOrigins.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }

  return headers
}

function jsonResponse(request: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(request),
  })
}

function toGeminiHistory(history: ChatMessage[]): Content[] {
  return history.map((message) => ({
    role: message.role,
    parts: [{ text: message.text }],
  }))
}

export default async function handler(request: Request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request),
    })
  }

  if (request.method !== 'POST') {
    return jsonResponse(request, 405, { error: 'Method not allowed' })
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY
    const body = (await request.json()) as ChatRequestBody
    const message = body.message?.trim()

    if (!apiKey) {
      return jsonResponse(request, 500, { error: 'Missing GEMINI_API_KEY.' })
    }

    if (!message) {
      return jsonResponse(request, 400, { error: 'Message is required.' })
    }

    const ai = new GoogleGenAI({ apiKey })
    const chat = ai.chats.create({
      model: 'gemini-2.5-flash',
      history: toGeminiHistory(body.history ?? []),
    })
    const response = await chat.sendMessage({ message })

    return jsonResponse(request, 200, { text: response.text ?? '' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Gemini error.'
    return jsonResponse(request, 500, { error: message })
  }
}
