import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FormEvent, MouseEvent, WheelEvent } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import "./App.css";

type Role = "user" | "model";

type Message = {
  id: string;
  role: Role;
  text: string;
};

type Branch = {
  id: string;
  sourceMessageId: string;
  sourceText: string;
  anchor: Point;
  anchorSource: "selection" | "message";
  position: Point;
  messages: Message[];
  draft: string;
  isSending: boolean;
  error: string;
};

type BranchTarget = {
  messageId: string;
  text: string;
  sourceRect: DOMRect;
  selectionRect: DOMRect;
};

type ContextMenu = {
  x: number;
  y: number;
  target: BranchTarget;
};

type Point = {
  x: number;
  y: number;
};

type MeasuredRect = Point & {
  width: number;
  height: number;
};

type ArrowLayout = {
  width: number;
  height: number;
  branchRects: Record<string, MeasuredRect>;
};

type ChatResponse = {
  text?: string;
  error?: string;
};

type HastText = {
  type: "text";
  value: string;
};

type HastElement = {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

type HastRoot = {
  type: "root";
  children: HastNode[];
};

type HastNode = HastRoot | HastElement | HastText;

const starterPrompt = "Ask Gemini something.";
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "";
const chatApiUrl =
  import.meta.env.VITE_CHAT_API_URL ?? `${apiBaseUrl}/api/chat`;
const branchCardViewportOffset = 18;
const branchCardMaxVisibleHeight = 520;
const branchCardWidth = 360;
const minBranchZoom = 0.5;
const maxBranchZoom = 1.25;
const branchZoomStep = 0.1;

function makeId() {
  return crypto.randomUUID();
}

function toChatHistory(messages: Message[]) {
  return messages.map((message) => ({
    role: message.role,
    text: message.text,
  }));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function roundZoom(value: number) {
  return Math.round(value * 100) / 100;
}

function arrowLayoutsMatch(first: ArrowLayout, second: ArrowLayout) {
  if (first.width !== second.width || first.height !== second.height) {
    return false;
  }

  const firstKeys = Object.keys(first.branchRects);
  const secondKeys = Object.keys(second.branchRects);
  if (firstKeys.length !== secondKeys.length) {
    return false;
  }

  return firstKeys.every((key) => {
    const firstRect = first.branchRects[key];
    const secondRect = second.branchRects[key];
    return (
      secondRect &&
      firstRect.x === secondRect.x &&
      firstRect.y === secondRect.y &&
      firstRect.width === secondRect.width &&
      firstRect.height === secondRect.height
    );
  });
}

function getBranchArrowPath(branch: Branch, rect?: MeasuredRect) {
  const fallbackRect = {
    x: branch.position.x,
    y: branch.position.y,
    width: branchCardWidth,
    height: branchCardMaxVisibleHeight,
  };
  const branchRect = rect ?? fallbackRect;
  const start = {
    x: Math.max(0, branch.anchor.x),
    y: branch.anchor.y,
  };
  const connectsToLeft = start.x <= branchRect.x + branchRect.width / 2;
  const target = {
    x: connectsToLeft ? branchRect.x : branchRect.x + branchRect.width,
    y: clamp(start.y, branchRect.y + 32, branchRect.y + branchRect.height - 32),
  };
  const direction = target.x >= start.x ? 1 : -1;
  const curve = clamp(Math.abs(target.x - start.x) * 0.45, 48, 220);

  return {
    start,
    target,
    path: `M ${start.x} ${start.y} C ${start.x + direction * curve} ${
      start.y
    }, ${target.x - direction * curve} ${target.y}, ${target.x} ${target.y}`,
  };
}

function renderHighlightedNodes(text: string, highlights: string[]): HastNode[] {
  const ranges = highlights
    .map((highlight) => {
      const start = text.indexOf(highlight);
      return start >= 0 ? { start, end: start + highlight.length } : null;
    })
    .filter((range): range is { start: number; end: number } => range !== null)
    .sort((first, second) => first.start - second.start);

  if (ranges.length === 0) {
    return [{ type: "text", value: text }];
  }

  const nodes: HastNode[] = [];
  let cursor = 0;

  ranges.forEach((range) => {
    if (range.start < cursor) {
      return;
    }

    if (range.start > cursor) {
      nodes.push({ type: "text", value: text.slice(cursor, range.start) });
    }

    nodes.push({
      type: "element",
      tagName: "mark",
      properties: { className: "branch-highlight" },
      children: [{ type: "text", value: text.slice(range.start, range.end) }],
    });
    cursor = range.end;
  });

  if (cursor < text.length) {
    nodes.push({ type: "text", value: text.slice(cursor) });
  }

  return nodes;
}

function hasClassName(node: HastElement, className: string) {
  const value = node.properties?.className;

  if (typeof value === "string") {
    return value.split(" ").includes(className);
  }

  return Array.isArray(value) && value.includes(className);
}

function createHighlightPlugin(highlights: string[]) {
  const activeHighlights = highlights.filter(Boolean);

  return function highlightPlugin() {
    return function transform(tree: HastNode) {
      if (activeHighlights.length === 0) {
        return;
      }

      function visit(node: HastNode) {
        if (!("children" in node) || !node.children) {
          return;
        }

        node.children = node.children.flatMap((child) => {
          if (child.type === "element" && hasClassName(child, "katex")) {
            return [child];
          }

          if (child.type === "text") {
            return renderHighlightedNodes(child.value, activeHighlights);
          }

          visit(child);
          return [child];
        });
      }

      visit(tree);
    };
  };
}

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [draggingBranchId, setDraggingBranchId] = useState<string | null>(null);
  const [branchZoom, setBranchZoom] = useState(1);
  const [arrowLayout, setArrowLayout] = useState<ArrowLayout>({
    width: 0,
    height: 0,
    branchRects: {},
  });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const conversationScrollRef = useRef<HTMLDivElement>(null);
  const messageElementsRef = useRef(new Map<string, HTMLElement>());
  const branchElementsRef = useRef(new Map<string, HTMLElement>());

  const visibleHistory = useMemo(() => toChatHistory(messages), [messages]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
        return;
      }

      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement)) {
        return;
      }

      const form = target.form;
      if (!form) {
        return;
      }

      event.preventDefault();
      form.requestSubmit();
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const registerMessageElement = useCallback(
    (messageId: string, element: HTMLElement | null) => {
      if (element) {
        messageElementsRef.current.set(messageId, element);
        return;
      }

      messageElementsRef.current.delete(messageId);
    },
    [],
  );

  const registerBranchElement = useCallback(
    (branchId: string, element: HTMLElement | null) => {
      if (element) {
        branchElementsRef.current.set(branchId, element);
        return;
      }

      branchElementsRef.current.delete(branchId);
    },
    [],
  );

  const measureBranchAnchor = useCallback((branch: Branch) => {
    const workspace = workspaceRef.current;
    const messageElement = messageElementsRef.current.get(branch.sourceMessageId);
    if (!workspace || !messageElement) {
      return null;
    }

    const workspaceRect = workspace.getBoundingClientRect();
    const highlightElement = Array.from(
      messageElement.querySelectorAll<HTMLElement>(".branch-highlight"),
    ).find((element) => element.textContent === branch.sourceText);
    const anchorRect =
      highlightElement?.getBoundingClientRect() ??
      messageElement.getBoundingClientRect();

    return {
      x:
        (anchorRect.right - workspaceRect.left + workspace.scrollLeft) /
        branchZoom,
      y:
        (anchorRect.top +
          anchorRect.height / 2 -
          workspaceRect.top +
          workspace.scrollTop) /
        branchZoom,
    };
  }, [branchZoom]);

  const refreshBranchAnchors = useCallback(() => {
    if (!workspaceRef.current) {
      return;
    }

    setBranches((current) => {
      let changed = false;

      const nextBranches = current.map((branch) => {
        const anchor = measureBranchAnchor(branch);
        if (
          !anchor ||
          (Math.abs(anchor.x - branch.anchor.x) < 0.5 &&
            Math.abs(anchor.y - branch.anchor.y) < 0.5)
        ) {
          return branch;
        }

        changed = true;
        return { ...branch, anchor };
      });

      return changed ? nextBranches : current;
    });
  }, [measureBranchAnchor]);

  const measureArrowLayout = useCallback(() => {
    const workspace = workspaceRef.current;
    if (!workspace) {
      return;
    }

    const nextBranchRects: Record<string, MeasuredRect> = {};
    let width = workspace.clientWidth / branchZoom;
    let height = workspace.clientHeight / branchZoom;

    branches.forEach((branch) => {
      const element = branchElementsRef.current.get(branch.id);
      if (!element) {
        width = Math.max(width, branch.position.x + branchCardWidth + 80);
        height = Math.max(
          height,
          branch.position.y + branchCardMaxVisibleHeight + 80,
        );
        return;
      }

      const measuredRect = {
        x: branch.position.x,
        y: branch.position.y,
        width: element.offsetWidth,
        height: element.offsetHeight,
      };

      nextBranchRects[branch.id] = measuredRect;
      width = Math.max(width, measuredRect.x + measuredRect.width + 80);
      height = Math.max(height, measuredRect.y + measuredRect.height + 80);
    });

    const nextLayout = {
      width: Math.ceil(width),
      height: Math.ceil(height),
      branchRects: nextBranchRects,
    };

    setArrowLayout((current) =>
      arrowLayoutsMatch(current, nextLayout) ? current : nextLayout,
    );
  }, [branches, branchZoom]);

  useLayoutEffect(() => {
    refreshBranchAnchors();
    measureArrowLayout();
  }, [branches, refreshBranchAnchors, measureArrowLayout]);

  function updateBranchZoom(nextZoom: number, focusPoint?: Point) {
    const workspace = workspaceRef.current;
    const clampedZoom = roundZoom(
      clamp(nextZoom, minBranchZoom, maxBranchZoom),
    );

    if (!workspace) {
      setBranchZoom(clampedZoom);
      return;
    }

    const viewportFocus = focusPoint ?? {
      x: workspace.clientWidth / 2,
      y: workspace.clientHeight / 2,
    };
    const canvasFocus = {
      x: (workspace.scrollLeft + viewportFocus.x) / branchZoom,
      y: (workspace.scrollTop + viewportFocus.y) / branchZoom,
    };

    setBranchZoom(clampedZoom);

    requestAnimationFrame(() => {
      workspace.scrollLeft = canvasFocus.x * clampedZoom - viewportFocus.x;
      workspace.scrollTop = canvasFocus.y * clampedZoom - viewportFocus.y;
    });
  }

  function zoomInBranches() {
    updateBranchZoom(branchZoom + branchZoomStep);
  }

  function zoomOutBranches() {
    updateBranchZoom(branchZoom - branchZoomStep);
  }

  function resetBranchZoom() {
    updateBranchZoom(1);
  }

  function handleWorkspaceWheel(event: WheelEvent<HTMLDivElement>) {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }

    event.preventDefault();
    const workspace = workspaceRef.current;
    if (!workspace) {
      return;
    }

    const workspaceRect = workspace.getBoundingClientRect();
    const direction = event.deltaY > 0 ? -1 : 1;

    updateBranchZoom(branchZoom + direction * branchZoomStep, {
      x: event.clientX - workspaceRect.left,
      y: event.clientY - workspaceRect.top,
    });
  }

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    const conversationScroll = conversationScrollRef.current;
    if (!workspace) {
      return;
    }

    const handleLayoutChange = () => {
      refreshBranchAnchors();
      measureArrowLayout();
    };

    const resizeObserver = new ResizeObserver(handleLayoutChange);
    resizeObserver.observe(workspace);
    branchElementsRef.current.forEach((element) => {
      resizeObserver.observe(element);
    });

    conversationScroll?.addEventListener("scroll", handleLayoutChange);
    window.addEventListener("resize", handleLayoutChange);

    return () => {
      resizeObserver.disconnect();
      conversationScroll?.removeEventListener("scroll", handleLayoutChange);
      window.removeEventListener("resize", handleLayoutChange);
    };
  }, [branches, refreshBranchAnchors, measureArrowLayout]);

  async function requestGemini(
    message: string,
    history: ReturnType<typeof toChatHistory>,
  ) {
    const response = await fetch(chatApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history }),
    });
    const data = (await response.json()) as ChatResponse;

    if (!response.ok) {
      throw new Error(data.error ?? "Gemini request failed.");
    }

    return data.text?.trim() || "Gemini returned an empty response.";
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || isSending) {
      return;
    }

    const userMessage: Message = { id: makeId(), role: "user", text };
    setMessages((current) => [...current, userMessage]);
    setDraft("");
    setError("");
    setContextMenu(null);
    setIsSending(true);

    try {
      const reply = await requestGemini(text, visibleHistory);
      setMessages((current) => [
        ...current,
        { id: makeId(), role: "model", text: reply },
      ]);
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Something went wrong.";
      setError(message);
      setMessages((current) =>
        current.filter((item) => item.id !== userMessage.id),
      );
    } finally {
      setIsSending(false);
      inputRef.current?.focus();
    }
  }

  async function sendBranchMessage(
    branchId: string,
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    const branch = branches.find((item) => item.id === branchId);
    const text = branch?.draft.trim();
    if (!branch || !text || branch.isSending) {
      return;
    }

    const branchUserMessage: Message = { id: makeId(), role: "user", text };
    const branchHistory = toChatHistory(branch.messages);
    const prompt =
      branch.messages.length === 0
        ? `I highlighted this excerpt from your earlier message:\n\n"${branch.sourceText}"\n\nMy question about it is: ${text}`
        : text;

    setBranches((current) =>
      current.map((item) =>
        item.id === branchId
          ? {
              ...item,
              draft: "",
              error: "",
              isSending: true,
              messages: [...item.messages, branchUserMessage],
            }
          : item,
      ),
    );

    try {
      const reply = await requestGemini(prompt, branchHistory);
      setBranches((current) =>
        current.map((item) =>
          item.id === branchId
            ? {
                ...item,
                isSending: false,
                messages: [
                  ...item.messages,
                  { id: makeId(), role: "model", text: reply },
                ],
              }
            : item,
        ),
      );
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Something went wrong.";
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
      );
    }
  }

  function clearChat() {
    setMessages([]);
    setBranches([]);
    setContextMenu(null);
    setError("");
    inputRef.current?.focus();
  }

  function updateBranchDraft(branchId: string, value: string) {
    setBranches((current) =>
      current.map((branch) =>
        branch.id === branchId ? { ...branch, draft: value } : branch,
      ),
    );
  }

  function closeBranch(branchId: string) {
    setBranches((current) =>
      current.filter((branch) => branch.id !== branchId),
    );
  }

  function moveBranch(branchId: string, position: Point) {
    setBranches((current) =>
      current.map((branch) =>
        branch.id === branchId ? { ...branch, position } : branch,
      ),
    );
  }

  function startBranchDrag(branchId: string, event: MouseEvent<HTMLElement>) {
    if (!workspaceRef.current) {
      return;
    }

    const branch = branches.find((item) => item.id === branchId);
    if (!branch) {
      return;
    }

    event.preventDefault();
    setDraggingBranchId(branchId);

    const startX = event.clientX;
    const startY = event.clientY;
    const startPosition = branch.position;
    const workspaceRect = workspaceRef.current.getBoundingClientRect();

    function handlePointerMove(pointerEvent: globalThis.MouseEvent) {
      moveBranch(branchId, {
        x: Math.max(
          8,
          Math.min(
            startPosition.x + (pointerEvent.clientX - startX) / branchZoom,
            (workspaceRect.width + workspaceRef.current!.scrollLeft) /
              branchZoom -
              branchCardWidth,
          ),
        ),
        y: Math.max(
          8,
          startPosition.y + (pointerEvent.clientY - startY) / branchZoom,
        ),
      });
    }

    function handlePointerUp() {
      setDraggingBranchId(null);
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("mouseup", handlePointerUp);
    }

    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("mouseup", handlePointerUp);
  }

  function openBranch() {
    if (!contextMenu || !workspaceRef.current) {
      return;
    }

    const workspace = workspaceRef.current;
    const workspaceRect = workspace.getBoundingClientRect();
    const selectionRect = contextMenu.target.selectionRect;
    const anchor = {
      x:
        (selectionRect.right - workspaceRect.left + workspace.scrollLeft) /
        branchZoom,
      y:
        (selectionRect.top +
          selectionRect.height / 2 -
          workspaceRect.top +
          workspace.scrollTop) /
        branchZoom,
    };
    const visibleTop =
      (Math.max(workspace.scrollTop, -workspaceRect.top) +
        branchCardViewportOffset) /
      branchZoom;
    const visibleBottom =
      (Math.max(workspace.scrollTop, -workspaceRect.top) +
        Math.min(window.innerHeight, workspaceRect.bottom) -
        branchCardViewportOffset) /
      branchZoom;
    const branchCardHeight = Math.min(
      branchCardMaxVisibleHeight,
      Math.max(320, window.innerHeight - 180),
    );
    const preferredY = anchor.y - 42;
    const maxVisibleY = Math.max(visibleTop, visibleBottom - branchCardHeight);
    const position = {
      x: Math.max(32, anchor.x + 48),
      y: clamp(preferredY, visibleTop, maxVisibleY),
    };

    setBranches((current) => [
      ...current,
      {
        id: makeId(),
        sourceMessageId: contextMenu.target.messageId,
        sourceText: contextMenu.target.text,
        anchor,
        anchorSource: "selection",
        position,
        messages: [],
        draft: "",
        isSending: false,
        error: "",
      },
    ]);
    setContextMenu(null);
    window.getSelection()?.removeAllRanges();
  }

  function handleMessageContextMenu(
    event: MouseEvent<HTMLElement>,
    messageId: string,
  ) {
    const sourceElement = event.currentTarget;
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();

    if (!selection || !selectedText || selection.rangeCount === 0) {
      return;
    }

    if (
      !sourceElement.contains(selection.anchorNode) ||
      !sourceElement.contains(selection.focusNode)
    ) {
      return;
    }

    const range = selection.getRangeAt(0);
    if (range.collapsed) {
      return;
    }

    const selectionRect = range.getBoundingClientRect();
    if (selectionRect.width === 0 && selectionRect.height === 0) {
      return;
    }

    event.preventDefault();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: {
        messageId,
        text: selectedText,
        sourceRect: sourceElement.getBoundingClientRect(),
        selectionRect,
      },
    });
  }

  function highlightsFor(messageId: string) {
    return branches
      .filter((branch) => branch.sourceMessageId === messageId)
      .map((branch) => branch.sourceText);
  }

  return (
    <main className="chat-shell" onClick={() => setContextMenu(null)}>
      <aside className="chat-rail">
        <header className="app-header">
          <div>
            <p className="eyebrow">BranchAI</p>
            <h1>Branching Gemini</h1>
          </div>
          <button type="button" className="ghost-button" onClick={clearChat}>
            Clear
          </button>
        </header>

        <section className="conversation" aria-live="polite">
          <div className="conversation-scroll" ref={conversationScrollRef}>
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
                  onContextMenu={handleMessageContextMenu}
                  onMessageElement={registerMessageElement}
                />
              ))
            )}
            {isSending && (
              <article className="message model pending">
                <div className="message-meta">Gemini</div>
                <p>Thinking...</p>
              </article>
            )}
          </div>
        </section>

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
              {isSending ? "Sending" : "Send"}
            </button>
          </div>
        </form>
      </aside>

      <div className="workspace" ref={workspaceRef} onWheel={handleWorkspaceWheel}>
        <div
          className="workspace-tools"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            aria-label="Zoom out branches"
            onClick={zoomOutBranches}
            disabled={branchZoom <= minBranchZoom}
          >
            -
          </button>
          <button type="button" onClick={resetBranchZoom}>
            {Math.round(branchZoom * 100)}%
          </button>
          <button
            type="button"
            aria-label="Zoom in branches"
            onClick={zoomInBranches}
            disabled={branchZoom >= maxBranchZoom}
          >
            +
          </button>
        </div>

        {branches.length === 0 && (
          <div className="workspace-empty">
            Highlight text in the chat rail and branch from it.
          </div>
        )}

        <div
          className="workspace-surface"
          style={{
            width: Math.max(arrowLayout.width * branchZoom, 1),
            height: Math.max(arrowLayout.height * branchZoom, 1),
          }}
        >
          <div
            className="workspace-canvas"
            style={{
              width: Math.max(arrowLayout.width, 1),
              height: Math.max(arrowLayout.height, 1),
              transform: `scale(${branchZoom})`,
            }}
          >
            {branches.map((branch) => (
              <BranchCard
                branch={branch}
                isDragging={draggingBranchId === branch.id}
                key={branch.id}
                onClose={closeBranch}
                onDraftChange={updateBranchDraft}
                onDragStart={startBranchDrag}
                onSubmit={sendBranchMessage}
                onContextMenu={handleMessageContextMenu}
                highlightsFor={highlightsFor}
                onMessageElement={registerMessageElement}
                onBranchElement={registerBranchElement}
              />
            ))}

            <svg
              className="branch-arrows"
              aria-hidden="true"
              width={Math.max(1, arrowLayout.width)}
              height={Math.max(1, arrowLayout.height)}
              viewBox={`0 0 ${Math.max(1, arrowLayout.width)} ${Math.max(
                1,
                arrowLayout.height,
              )}`}
            >
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
              {branches.map((branch) => {
                const arrow = getBranchArrowPath(
                  branch,
                  arrowLayout.branchRects[branch.id],
                );

                return (
                  <g key={branch.id}>
                    <circle
                      className="branch-arrow-origin"
                      cx={arrow.start.x}
                      cy={arrow.start.y}
                      r="3"
                    />
                    <path d={arrow.path} markerEnd="url(#arrowhead)" />
                  </g>
                );
              })}
            </svg>
          </div>
        </div>

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
    </main>
  );
}

function ChatMessage({
  message,
  highlights,
  onContextMenu,
  onMessageElement,
}: {
  message: Message;
  highlights: string[];
  onContextMenu: (event: MouseEvent<HTMLElement>, messageId: string) => void;
  onMessageElement: (messageId: string, element: HTMLElement | null) => void;
}) {
  const highlightPlugin = useMemo(
    () => createHighlightPlugin(highlights),
    [highlights],
  );

  return (
    <article
      className={`message ${message.role}`}
      onContextMenu={(event) => onContextMenu(event, message.id)}
      ref={(element) => onMessageElement(message.id, element)}
    >
      <div className="message-meta">
        {message.role === "user" ? "You" : "Gemini"}
      </div>
      <div className="message-content">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex, highlightPlugin]}
        >
          {message.text}
        </ReactMarkdown>
      </div>
    </article>
  );
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
  onMessageElement,
  onBranchElement,
}: {
  branch: Branch;
  isDragging: boolean;
  onClose: (branchId: string) => void;
  onDraftChange: (branchId: string, value: string) => void;
  onDragStart: (branchId: string, event: MouseEvent<HTMLElement>) => void;
  onSubmit: (branchId: string, event: FormEvent<HTMLFormElement>) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>, messageId: string) => void;
  highlightsFor: (messageId: string) => string[];
  onMessageElement: (messageId: string, element: HTMLElement | null) => void;
  onBranchElement: (branchId: string, element: HTMLElement | null) => void;
}) {
  return (
    <aside
      className={`branch-card ${isDragging ? "dragging" : ""}`}
      ref={(element) => onBranchElement(branch.id, element)}
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
          <p className="branch-empty">
            Ask a focused question about the highlight.
          </p>
        ) : (
          branch.messages.map((message) => (
            <ChatMessage
              highlights={highlightsFor(message.id)}
              key={message.id}
              message={message}
              onContextMenu={onContextMenu}
              onMessageElement={onMessageElement}
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

      <form
        className="branch-composer"
        onSubmit={(event) => onSubmit(branch.id, event)}
      >
        {branch.error && <p className="error">{branch.error}</p>}
        <textarea
          value={branch.draft}
          onChange={(event) => onDraftChange(branch.id, event.target.value)}
          placeholder="Ask about this part"
          rows={3}
        />
        <button
          type="submit"
          disabled={!branch.draft.trim() || branch.isSending}
        >
          {branch.isSending ? "Sending" : "Ask"}
        </button>
      </form>
    </aside>
  );
}

export default App;
