// Workbench stories (pnpm workbench feedback): the feedback sheet.
import { Feedback } from "./Feedback.tsx";

const noop = () => {};

export const Default = () => <Feedback onClose={noop} />;
