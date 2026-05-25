# BranchAI

BranchAI is a branching chat interface for Gemini. It keeps the main conversation in a left rail and lets you highlight text from any message to open focused side branches in a zoomable workspace.

<img width="1415" height="762" alt="demo" src="https://github.com/user-attachments/assets/f5241cd4-4b0a-427d-a9bd-936620345680" />


## What It Does

- Chat with Gemini through a server-side API endpoint.
- Highlight text in a message, right-click it, and create a branch from that exact selection.
- Keep each branch as its own focused thread with separate message history.
- Drag branch cards around the workspace and zoom the branch canvas in or out.
- Render Markdown, GitHub-flavored Markdown, and math notation with KaTeX.
- Visually link each branch back to the source text with highlighted message spans and connector arrows.

## Tech Stack

- React 19
- TypeScript
- Vite
- Tailwind CSS tooling
- Google GenAI SDK
- React Markdown, remark-gfm, remark-math, rehype-katex
- Netlify Functions and Vercel-style API route support

## Project Structure

```text
branchAI/
  api/chat.ts                 # Vercel-style Gemini API route
  netlify/functions/chat.ts   # Netlify Gemini function
  src/App.tsx                 # Main chat and branching workspace
  src/App.css                 # App-specific styling
  vite.config.ts              # Vite config plus local /api/chat middleware
```

## Environment

Create a `.env` file in `branchAI/`:

```bash
GEMINI_API_KEY=your_google_ai_studio_key_here
```

For a deployed frontend that calls a separate backend endpoint, also set:

```bash
VITE_CHAT_API_URL=https://your-site.example/.netlify/functions/chat
```

If `VITE_CHAT_API_URL` is not set, the app posts to `/api/chat`. During local Vite development, `vite.config.ts` provides that endpoint through middleware.

## Getting Started

```bash
npm install
npm run dev
```

Open the local Vite URL printed in the terminal. The app expects `GEMINI_API_KEY` to be available before chat requests will work.

## Available Scripts

```bash
npm run dev       # Start the Vite dev server
npm run build     # Type-check and build for production
npm run lint      # Run ESLint
npm run preview   # Preview the production build
npm run deploy    # Build and publish dist/ with gh-pages
```

## Deployment Notes

- Netlify deployments can use `netlify/functions/chat.ts`.
- Vercel-style deployments can use `api/chat.ts`.
- The API key should only be stored on the server or hosting provider, not in client-side code.
- CORS allowlists are defined in the API function files and may need to be updated for new production domains.
