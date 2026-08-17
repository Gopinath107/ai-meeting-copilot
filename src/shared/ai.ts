export type AiIntent = 'answer' | 'analyze' | 'summarize' | 'minutes'

export type AiTextMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type ScreenshotContext = {
  dataUrl: `data:image/jpeg;base64,${string}`
  capturedAt: number
  width: number
  height: number
  detail: 'low' | 'auto' | 'high'
}

export type AiAskRequest = {
  requestId: string
  intent: AiIntent
  messages: AiTextMessage[]
  screenshot?: ScreenshotContext
}

export type AiTokenEvent = { requestId: string; text: string }
export type AiDoneEvent = { requestId: string }
export type AiErrorEvent = { requestId: string; message: string }
