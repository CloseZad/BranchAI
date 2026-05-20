import { useMemo, useRef, useState } from 'react'
import type { FormEvent, MouseEvent, ReactNode } from 'react'
import './App.css'

type Role = 'user' | 'model'

type Message = {
  id: string
  role: Role
  text: string
}

type Branch = {
  id: string
  sourceMessageId: string
  sourceText: string
  anchor: Point
  position: Point
  messages: Message[]
  draft: string
  isSending: boolean
  error: string
}

type BranchTarget = {
  messageId: string
  text: string
  rect: DOMRect
}

type ContextMenu = {
  x: number
  y: number
  target: BranchTarget
}

type Point = {
  x: number
  y: number
}

type ChatResponse = {
  text?: string
  error?: string
}

const starterPrompt =
  'Ask Gemini something. Each turn sends the prior conversation back as context.'
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? ''
const chatApiUrl = import.meta.env.VITE_CHAT_API_URL ?? `${apiBaseUrl}/api/chat`

function makeId() {
  return crypto.randomUUID()
}

function toChatHistory(messages: Message[]) {
  return messages.map((message) => ({
    role: message.role,
    text: message.text,
  }))
}

function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const [draggingBranchId, setDraggingBranchId] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)

  const visibleHistory = useMemo(() => toChatHistory(messages), [messages])

  async function requestGemini(message: string, history: ReturnType<typeof toChatHistory>) {
    const response = await fetch(chatApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history }),
    })
    const data = (await response.json()) as ChatResponse

    if (!response.ok) {
      throw new Error(data.error ?? 'Gemini request failed.')
    }

    return data.text?.trim() || 'Gemini returned an empty response.'
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const text = draft.trim()
    if (!text || isSending) {
      return
    }

    const userMessage: Message = { id: makeId(), role: 'user', text }
    setMessages((current) => [...current, userMessage])
    setDraft('')
    setError('')
    setContextMenu(null)
    setIsSending(true)

    try {
      const reply = await requestGemini(text, visibleHistory)
      setMessages((current) => [
        ...current,
        { id: makeId(), role: 'model', text: reply },
      ])
    } catch (caughtError) {
      const message =
        caughtError instanceof Error ? caughtError.message : 'Something went wrong.'
      setError(message)
      setMessages((current) => current.filter((item) => item.id !== userMessage.id))
    } finally {
      setIsSending(false)
      inputRef.current?.focus()
    }
  }

  async function sendBranchMessage(branchId: string, event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const branch = branches.find((item) => item.id === branchId)
    const text = branch?.draft.trim()
    if (!branch || !text || branch.isSending) {
      return
    }

    const branchUserMessage: Message = { id: makeId(), role: 'user', text }
    const branchHistory = toChatHistory(branch.messages)
    const prompt =
      branch.messages.length === 0
        ? `I highlighted this excerpt from your earlier answer:\n\n"${branch.sourceText}"\n\nMy question about it is: ${text}`
        : text

    setBranches((current) =>
      current.map((item) =>
        item.id === branchId
          ? {
              ...item,
              draft: '',
              error: '',
              isSending: true,
              messages: [...item.messages, branchUserMessage],
            }
          : item,
      ),
    )

    try {
      const reply = await requestGemini(prompt, branchHistory)
      setBranches((current) =>
        current.map((item) =>
          item.id === branchId
            ? {
                ...item,
                isSending: false,
                messages: [...item.messages, { id: makeId(), role: 'model', text: reply }],
              }
            : item,
        ),
      )
    } catch (caughtError) {
      const message =
        caughtError instanceof Error ? caughtError.message : 'Something went wrong.'
      setBranches((current) =>
        current.map((item) =>
          item.id === branchId
            ? {
                ...item,
                error: message,
                isSending: false,
                messages: item.messages.filter(
                  (branchMessage) => branchMessage.id !== branchUserMessage.id,
                ),
              }
            : item,
        ),
      )
    }
  }

  function clearChat() {
    setMessages([])
    setBranches([])
    setContextMenu(null)
    setError('')
    inputRef.current?.focus()
  }

  function updateBranchDraft(branchId: string, value: string) {
    setBranches((current) =>
      current.map((branch) =>
        branch.id === branchId ? { ...branch, draft: value } : branch,
      ),
    )
  }

  function closeBranch(branchId: string) {
    setBranches((current) => current.filter((branch) => branch.id !== branchId))
  }

  function moveBranch(branchId: string, position: Point) {
    setBranches((current) =>
      current.map((branch) =>
        branch.id === branchId ? { ...branch, position } : branch,
      ),
    )
  }

  function startBranchDrag(branchId: string, event: MouseEvent<HTMLElement>) {
    if (!workspaceRef.current) {
      return
    }

    const branch = branches.find((item) => item.id === branchId)
    if (!branch) {
      return
    }

    event.preventDefault()
    setDraggingBranchId(branchId)

    const startX = event.clientX
    const startY = event.clientY
    const startPosition = branch.position
    const workspaceRect = workspaceRef.current.getBoundingClientRect()

    function handlePointerMove(pointerEvent: globalThis.MouseEvent) {
      const nextX = startPosition.x + pointerEvent.clientX - startX
      const nextY = startPosition.y + pointerEvent.clientY - startY

      moveBranch(branchId, {
        x: Math.max(
          8,
          Math.min(nextX, workspaceRect.width + workspaceRef.current!.scrollLeft - 380),
        ),
        y: Math.max(8, nextY),
      })
    }

    function handlePointerUp() {
      setDraggingBranchId(null)
      window.removeEventListener('mousemove', handlePointerMove)
      window.removeEventListener('mouseup', handlePointerUp)
    }

    window.addEventListener('mousemove', handlePointerMove)
    window.addEventListener('mouseup', handlePointerUp)
  }

  function openBranch() {
    if (!contextMenu || !workspaceRef.current) {
      return
    }

    const workspaceRect = workspaceRef.current.getBoundingClientRect()
    const anchor = {
      x: contextMenu.target.rect.right - workspaceRect.left,
      y: contextMenu.target.rect.top + contextMenu.target.rect.height / 2 - workspaceRect.top,
    }
    const position = {
      x: anchor.x + 48,
      y: Math.max(anchor.y - 42, 8),
    }

    setBranches((current) => [
      ...current,
      {
        id: makeId(),
        sourceMessageId: contextMenu.target.messageId,
        sourceText: contextMenu.target.text,
        anchor,
        position,
        messages: [],
        draft: '',
        isSending: false,
        error: '',
      },
    ])
    setContextMenu(null)
    window.getSelection()?.removeAllRanges()
  }

  function handleModelContextMenu(
    event: MouseEvent<HTMLElement>,
    messageId: string,
  ) {
    const selection = window.getSelection()
    const selectedText = selection?.toString().trim()

    if (!selection || !selectedText || selection.rangeCount === 0) {
      return
    }

    if (!event.currentTarget.contains(selection.anchorNode)) {
      return
    }

    const range = selection.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) {
      return
    }

    event.preventDefault()
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: {
        messageId,
        text: selectedText,
        rect,
      },
    })
  }

  function highlightsFor(messageId: string) {
    return branches
      .filter((branch) => branch.sourceMessageId === messageId)
      .map((branch) => branch.sourceText)
  }

  return (
    <main className="chat-shell" onClick={() => setContextMenu(null)}>
      <header className="app-header">
        <div>
          <p className="eyebrow">BranchAI</p>
          <h1>Gemini chat shell</h1>
        </div>
        <button type="button" className="ghost-button" onClick={clearChat}>
          Clear
        </button>
      </header>

      <div className="workspace" ref={workspaceRef}>
        <section
          className={`conversation ${branches.length > 0 ? 'has-branches' : ''}`}
          aria-live="polite"
        >
          {messages.length === 0 ? (
            <div className="empty-state">
              <p>{starterPrompt}</p>
            </div>
          ) : (
            messages.map((message) => (
              <ChatMessage
                key={message.id}
                message={message}
                highlights={highlightsFor(message.id)}
                onContextMenu={handleModelContextMenu}
              />
            ))
          )}
          {isSending && (
            <article className="message model pending">
              <div className="message-meta">Gemini</div>
              <p>Thinking...</p>
            </article>
          )}
        </section>

        {branches.map((branch) => (
          <BranchCard
            branch={branch}
            isDragging={draggingBranchId === branch.id}
            key={branch.id}
            onClose={closeBranch}
            onDraftChange={updateBranchDraft}
            onDragStart={startBranchDrag}
            onSubmit={sendBranchMessage}
            onContextMenu={handleModelContextMenu}
            highlightsFor={highlightsFor}
          />
        ))}

        <svg className="branch-arrows" aria-hidden="true">
          <defs>
            <marker
              id="arrowhead"
              markerHeight="8"
              markerWidth="8"
              orient="auto"
              refX="7"
              refY="4"
            >
              <path d="M0,0 L8,4 L0,8 Z" />
            </marker>
          </defs>
          {branches.map((branch) => (
            <path
              d={`M ${branch.anchor.x} ${branch.anchor.y} C ${branch.anchor.x + 24} ${
                branch.anchor.y
              }, ${branch.position.x - 28} ${branch.position.y + 28}, ${
                branch.position.x - 6
              } ${branch.position.y + 28}`}
              key={branch.id}
              markerEnd="url(#arrowhead)"
            />
          ))}
        </svg>

        {contextMenu && (
          <div
            className="branch-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" onClick={openBranch}>
              Branch
            </button>
          </div>
        )}
      </div>

      <form className="composer" onSubmit={sendMessage}>
        {error && <p className="error">{error}</p>}
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Send a prompt to Gemini"
          rows={4}
        />
        <div className="composer-actions">
          <span>{messages.length} saved turns</span>
          <button type="submit" disabled={!draft.trim() || isSending}>
            {isSending ? 'Sending' : 'Send'}
          </button>
        </div>
      </form>
    </main>
  )
}

function ChatMessage({
  message,
  highlights,
  onContextMenu,
}: {
  message: Message
  highlights: string[]
  onContextMenu: (event: MouseEvent<HTMLElement>, messageId: string) => void
}) {
  return (
    <article className={`message ${message.role}`}>
      <div className="message-meta">{message.role === 'user' ? 'You' : 'Gemini'}</div>
      <p
        onContextMenu={
          message.role === 'model'
            ? (event) => onContextMenu(event, message.id)
            : undefined
        }
      >
        {renderHighlightedText(message.text, highlights)}
      </p>
    </article>
  )
}

function BranchCard({
  branch,
  isDragging,
  onClose,
  onDraftChange,
  onDragStart,
  onSubmit,
  onContextMenu,
  highlightsFor,
}: {
  branch: Branch
  isDragging: boolean
  onClose: (branchId: string) => void
  onDraftChange: (branchId: string, value: string) => void
  onDragStart: (branchId: string, event: MouseEvent<HTMLElement>) => void
  onSubmit: (branchId: string, event: FormEvent<HTMLFormElement>) => void
  onContextMenu: (event: MouseEvent<HTMLElement>, messageId: string) => void
  highlightsFor: (messageId: string) => string[]
}) {
  return (
    <aside
      className={`branch-card ${isDragging ? 'dragging' : ''}`}
      style={{ left: branch.position.x, top: branch.position.y }}
    >
      <header
        className="branch-card-header"
        onMouseDown={(event) => onDragStart(branch.id, event)}
      >
        <div>
          <span>Branch</span>
          <blockquote>{branch.sourceText}</blockquote>
        </div>
        <button
          type="button"
          aria-label="Close branch"
          onClick={() => onClose(branch.id)}
          onMouseDown={(event) => event.stopPropagation()}
        >
          x
        </button>
      </header>

      <div className="branch-thread">
        {branch.messages.length === 0 ? (
          <p className="branch-empty">Ask a focused question about the highlight.</p>
        ) : (
          branch.messages.map((message) => (
            <ChatMessage
              highlights={highlightsFor(message.id)}
              key={message.id}
              message={message}
              onContextMenu={onContextMenu}
            />
          ))
        )}
        {branch.isSending && (
          <article className="message model pending">
            <div className="message-meta">Gemini</div>
            <p>Thinking...</p>
          </article>
        )}
      </div>

      <form className="branch-composer" onSubmit={(event) => onSubmit(branch.id, event)}>
        {branch.error && <p className="error">{branch.error}</p>}
        <textarea
          value={branch.draft}
          onChange={(event) => onDraftChange(branch.id, event.target.value)}
          placeholder="Ask about this part"
          rows={3}
        />
        <button type="submit" disabled={!branch.draft.trim() || branch.isSending}>
          {branch.isSending ? 'Sending' : 'Ask'}
        </button>
      </form>
    </aside>
  )
}

function renderHighlightedText(text: string, highlights: string[]) {
  const ranges = highlights
    .map((highlight) => {
      const start = text.indexOf(highlight)
      return start >= 0 ? { start, end: start + highlight.length } : null
    })
    .filter((range): range is { start: number; end: number } => range !== null)
    .sort((first, second) => first.start - second.start)

  if (ranges.length === 0) {
    return text
  }

  const nodes: ReactNode[] = []
  let cursor = 0

  ranges.forEach((range, index) => {
    if (range.start < cursor) {
      return
    }

    if (range.start > cursor) {
      nodes.push(text.slice(cursor, range.start))
    }

    nodes.push(
      <mark className="branch-highlight" key={`${range.start}-${index}`}>
        {text.slice(range.start, range.end)}
      </mark>,
    )
    cursor = range.end
  })

  if (cursor < text.length) {
    nodes.push(text.slice(cursor))
  }

  return nodes
}

export default App
