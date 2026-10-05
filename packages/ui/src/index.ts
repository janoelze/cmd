// @cmd/ui: cmd's controls and the tokens they're drawn with. Import the styles
// once per page ("@cmd/ui/ui.css"), wrap the app in <UIProvider icon={…}> to
// draw icons natively, and build views from these instead of new CSS. The
// gallery (pnpm ui) shows every component in every theme.
//
// Themes: "@cmd/ui/themes" (registry, applyTheme) and "@cmd/ui/themes/builtin"
// (registers the built-in themes).

export { Button, ButtonGroup, IconButton, LinkButton, type ButtonProps, type ButtonVariant, type IconButtonProps, type Size } from "./button.tsx";
export { Checkbox, RadioGroup, Segmented, Select, Switch, TabPanel, Tabs, type Option, type TabItem } from "./choice.tsx";
export { ClearButton, NumberField, SearchField, SecretField, TextArea, TextField, type TextAreaProps, type TextFieldProps } from "./fields.tsx";
export { ICON, Icon, UIProvider, iconNode, type IconProps, type IconWeight } from "./icon.tsx";
export { Callout, Card, CodeBlock, EmptyState, FormRow, FormSection, Group, KeyValue, ResetButton, SectionHeading, Separator, Spacer, Toolbar } from "./layout.tsx";
export { ConfirmDialog, Dialog, Menu, Popover, Toast, Toaster, dismissToast, placePopover, toast, type MenuItemProps, type ToastOptions } from "./overlay.tsx";
export { Badge, Kbd, PageDots, Progress, ProgressRing, Spinner, StatusDot, type DotState, type Tone } from "./status.tsx";
export { installScrollbars, SCROLLBAR_CSS } from "./scrollbars.ts";
export { installTooltips, placeTip, useTooltip, type TipSide } from "./tooltips.tsx";
