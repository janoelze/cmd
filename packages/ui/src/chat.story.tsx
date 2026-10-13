// A conversation with an agent that acts (a model with tools): requests, answers, steps in every state,
// a step waiting for approval, a note when a turn was stopped.
import { ChatApproval, ChatComposer, ChatLog, ChatMessage, ChatNote, ChatStep } from "./chat.tsx";
import { AiField } from "./ai.tsx";
import { Stack } from "./frame.tsx";
import { CodeBlock } from "./layout.tsx";

const frame = { width: 420 };

/** A turn: the request, steps as they ran (looks quiet, acts with the window they're about), the answer. */
export const Conversation = () => (
  <div style={frame}>
    <ChatLog>
      <ChatMessage from="person" copy="Run the tests and start an agent on whatever fails.">
        Run the tests and start an agent on whatever fails.
      </ChatMessage>
      <Stack gap={0}>
        <ChatStep icon="eye" title="Looking at the board" state="done" quiet time="0.1s" />
        <ChatStep icon="play" title="Running the tests" state="done" target="pnpm test" onTarget={() => {}} time="14.2s">
          <CodeBlock>{"pnpm test\n✗ 2 failed, 312 passed"}</CodeBlock>
        </ChatStep>
        <ChatStep icon="text.alignleft" title="Reading the failures" state="done" quiet target="pnpm test" onTarget={() => {}} time="0.2s" />
        <ChatStep icon="person.badge.plus" title="Starting Claude on the failing parser test" state="running" target="Claude · parser" onTarget={() => {}} />
      </Stack>
      <ChatMessage from="agent" copy="Two tests fail in `osc.test.ts`. Claude is on it in its own terminal; I'll tell you when it's done.">
        <p>
          Two tests fail in <code>osc.test.ts</code>. Claude is on it in its own terminal; I'll tell you when it's done.
        </p>
      </ChatMessage>
    </ChatLog>
  </div>
);

/** An answer with headings, lists (nested) and code, as a model writes them. */
export const Answer = () => (
  <div style={frame}>
    <ChatMessage from="agent" copy="…">
      <p>No agent turns today, only commits. What got built:</p>
      <ul>
        <li>
          <strong>Release v0.26.0 (18:13):</strong> friendlier boot text, the footer, the UI Workbench staying up.
        </li>
        <li>
          <strong>Bug-fix batches</strong> (<code>ar1-small</code>, <code>ar1-batch2</code>):
          <ul>
            <li>Agent events the app can't read are skipped.</li>
            <li>Every settings key ever shipped is locked.</li>
          </ul>
        </li>
      </ul>
      <ol>
        <li>Run the tests.</li>
        <li>Start an agent on what fails.</li>
      </ol>
    </ChatMessage>
  </div>
);

/** Every state a step can be in. */
export const Steps = () => (
  <div style={frame}>
    <Stack gap={0}>
      <ChatStep icon="eye" title="Looking at the board" state="done" quiet time="0.1s" />
      <ChatStep icon="play" title="Running the dev server" state="running" target="pnpm dev" onTarget={() => {}} />
      <ChatStep icon="keyboard" title="Typing the migration command" state="waiting" target="zsh — api" onTarget={() => {}} />
      <ChatStep icon="xmark.circle" title="Closing the build terminal" state="failed" target="build" time="0.0s">
        <CodeBlock tone="danger">w6 is closed: look again</CodeBlock>
      </ChatStep>
      <ChatStep icon="keyboard" title="Typing rm -rf dist" state="denied" target="zsh — api" />
    </Stack>
  </div>
);

/** A step waiting for the person: in words, exactly, and the three answers. */
export const Approval = () => (
  <div style={frame}>
    <ChatApproval title="Type in the terminal in api" exact="pnpm db:migrate --env staging  ⏎" always="commands starting “pnpm db:migrate”" onAnswer={() => {}} />
  </div>
);

/** A streaming answer, and the note a stopped turn leaves. */
export const Streaming = () => (
  <div style={frame}>
    <Stack gap={3}>
      <ChatMessage from="agent" streaming>
        <p>The dev server is up on localhost:5173. Opening it next to</p>
      </ChatMessage>
      <ChatNote>Stopped.</ChatNote>
      <ChatNote tone="danger">Something went wrong: the provider is overloaded.</ChatNote>
    </Stack>
  </div>
);

/** The prompt's place under the conversation. */
export const Composer = () => (
  <div style={frame}>
    <ChatComposer>
      <AiField value="" onChange={() => {}} onSubmit={() => {}} placeholder="What should I do?" aria-label="Ask" />
    </ChatComposer>
  </div>
);
