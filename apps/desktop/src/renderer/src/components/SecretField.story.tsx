// Workbench stories (pnpm workbench secretfield): the kit's SecretField in every
// state, as the AI rows use it (live, with the provider's verdict attached).
// Checking and Rejected paste a key themselves to get there.
import { useEffect, useRef, type ReactNode } from "react";
import { FormRow, FormSection, LinkButton, SecretField } from "@cmd/ui";

const never = () => new Promise<void>(() => {});
const refuse = () => new Promise<void>((_, no) => setTimeout(() => no(new Error("refused")), 300));
const noop = () => {};

/** Pastes a key into the field inside it, once mounted. */
function Pasted({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const input = ref.current?.querySelector("input");
    if (!input) return;
    input.focus();
    input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "sk-ant-api03-example");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, []);
  return (
    <div ref={ref} style={{ display: "contents" }}>
      {children}
    </div>
  );
}

const getKey = <LinkButton>Get a key</LinkButton>;

export const States = () => (
  <div style={{ width: 420 }}>
    <FormSection>
      <FormRow title="Empty" titleAside={getKey} stacked>
        <SecretField set={false} live fill size="lg" placeholder="Paste an API key" onSave={noop} />
      </FormRow>
      <FormRow title="Checking" stacked>
        <Pasted>
          <SecretField set={false} live fill size="lg" placeholder="Paste an API key" onSave={never} />
        </Pasted>
      </FormRow>
      <FormRow title="Rejected" titleAside={getKey} note="Anthropic didn't accept this key." noteTone="danger" stacked>
        <Pasted>
          <SecretField set={false} live fill size="lg" placeholder="Paste an API key" onSave={refuse} />
        </Pasted>
      </FormRow>
      <FormRow title="Accepted" note="Ready · Claude Sonnet and Claude Haiku" stacked>
        <SecretField set hint="…a3f9" live fill size="lg" status={{ tone: "success", label: "Accepted" }} onSave={noop} />
      </FormRow>
      <FormRow title="Not checked" note="Couldn't reach Anthropic. It's checked again when cmd is online." noteTone="warning" stacked>
        <SecretField set hint="…a3f9" live fill size="lg" status={{ tone: "warning", label: "Not checked" }} onSave={noop} />
      </FormRow>
    </FormSection>
    <FormSection title="Without checking (Settings, Magic widget tokens)">
      <FormRow title="Token">
        <SecretField set={false} placeholder="Paste a token" onSave={noop} />
      </FormRow>
      <FormRow title="Stored token">
        <SecretField set hint="…9c2e" onSave={noop} />
      </FormRow>
    </FormSection>
  </div>
);
