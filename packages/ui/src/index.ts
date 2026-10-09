// @cmd/ui: cmd's controls and the tokens they're drawn with. Import the styles
// once per page ("@cmd/ui/ui.css"), wrap the app in <UIProvider icon={…}> to
// draw icons natively, and build views from these instead of new CSS. The
// gallery (pnpm ui) shows every component in every theme.
//
// Themes: "@cmd/ui/themes" (registry, applyTheme) and "@cmd/ui/themes/builtin"
// (registers the built-in themes).

export { AiField, type AiFieldProps, type AiState } from "./ai.tsx";
export { Button, ButtonGroup, IconButton, LinkButton, type ButtonProps, type ButtonVariant, type IconButtonProps, type Size } from "./button.tsx";
export { Checkbox, RadioGroup, Segmented, Select, Switch, TabPanel, Tabs, type Option, type TabItem } from "./choice.tsx";
export { ClearButton, NumberField, SearchField, SecretField, TextArea, TextField, type SecretStatus, type TextAreaProps, type TextFieldProps } from "./fields.tsx";
export { FindBar, findCount, Glyph, Highlight, NO_FIND_OPTIONS, type FindBarHandle, type FindBarProps, type FindOptions, type FindResults } from "./find.tsx";
export { Chart, Legend, Sparkline, type Series } from "./chart.tsx";
export { Document, Filmstrip, Hide, Picture, Thumb, Thumbs, Viewport, Inline, List, ListGroup, Measure, MediaStage, Pane, Panes, Split, Stack, Stat, StatusLine, Text, Tiles, View, ViewState, type Space, type ViewStateSpec } from "./frame.tsx";
export { Ribbon, Timeline, TimelineEntry, type RibbonItem } from "./timeline.tsx";
export { DataGrid, type DataGridProps, type GridCell, type GridColumn, type GridSort } from "./grid.tsx";
export { Chip, ListHeading, ListMark, ListRow, ListSection, ListValue, Panel, PanelBody, PanelHeader, PanelSummary, Twisty, type ListRowProps } from "./list.tsx";
export { ICON, Icon, UIProvider, iconNode, type IconProps, type IconWeight } from "./icon.tsx";
export { Callout, Card, CodeBlock, EmptyState, FeatureList, FormRow, FormSection, Group, InfoButton, KeyValue, Prose, ResetButton, SectionHeading, Separator, SheetHeader, Spacer, Toolbar } from "./layout.tsx";
export { ConfirmDialog, Dialog, Menu, Popover, Toast, Toaster, dismissToast, placePopover, toast, type Align, type MenuItemProps, type ToastOptions } from "./overlay.tsx";
export { Badge, Kbd, PageDots, Progress, ProgressRing, Spinner, StatusDot, type DotState, type Tone } from "./status.tsx";
export { installScrollbars, scrollbarScript, scrolled, watchScrollbars, PAGE_SCROLLBAR_CSS, SCROLLBAR_CSS, SCROLLBAR_HOLD, type ScrollbarsOptions } from "./scrollbars.ts";
export { displayAddress, ToolbarAddressField, ToolbarButton, ToolbarField, ToolbarSearchField, ToolbarGroup, ToolbarMenu, ToolbarPath, ToolbarSegmented, ToolbarSeparator, ToolbarSpacer, ToolbarText, WindowToolbar, type ToolbarButtonProps, type ToolbarFieldProps } from "./toolbar.tsx";
export { EASE, EASE_EXIT, glide, GLIDE_EASING, GLIDE_MS, glideNow, MOTION, tween, reducedMotion, slide, spring, timing, useFlip, usePresence, usePresentValue } from "./motion.ts";
export { Window, WindowBar, WindowBarMenu, WindowBody, WindowFrame } from "./window.tsx";
export { installTooltips, placeTip, useTooltip, type TipSide } from "./tooltips.tsx";
