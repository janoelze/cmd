// @cmd/ui: cmd's controls and the tokens they're drawn with. Import the styles
// once per page ("@cmd/ui/ui.css"), wrap the app in <UIProvider icon={…}> to
// draw icons natively, and build views from these instead of new CSS. The
// UI Workbench (pnpm workbench, docs/48) shows every component, its stories beside it.
//
// Themes: "@cmd/ui/themes" (registry, applyTheme) and "@cmd/ui/themes/builtin"
// (registers the built-in themes).

export { AiField, type AiFieldProps, type AiState } from "./ai.tsx";
export { ApprovalSheet, type ApprovalAnswer } from "./approval.tsx";
export { ChatApproval, ChatComposer, ChatLog, ChatMessage, ChatNote, ChatStep, useStickToEnd, type ChatStepState } from "./chat.tsx";
export { Button, ButtonGroup, IconButton, LinkButton, type ButtonProps, type ButtonVariant, type IconButtonProps, type Size } from "./button.tsx";
export { Checkbox, RadioGroup, Segmented, Select, Switch, TabPanel, Tabs, type Option, type TabItem } from "./choice.tsx";
export { ClearButton, NumberField, SearchField, SecretField, ShortcutField, TextArea, TextField, type SecretStatus, type TextAreaProps, type TextFieldProps } from "./fields.tsx";
export { FindBar, findCount, Glyph, Highlight, NO_FIND_OPTIONS, type FindBarHandle, type FindBarProps, type FindOptions, type FindResults } from "./find.tsx";
export { Chart, Legend, Sparkline, type Series } from "./chart.tsx";
export { Bars, Line, Plot, PlotGroup, Rule, Ticks, axisTicks, seriesColor, usePlot, useSize, type ChartSeries, type PlotProps, type PlotScales } from "./plot.tsx";
export { Calendar, ChartHead, Delta, Distribution, Meter, PunchCard, Proportion, Ranking, TimeBars, TimeSeries, heatLevels, type RankingRow, type TimeChartProps } from "./charts.tsx";
export { Dial, Document, Filmstrip, Hide, Picture, Viewport, Inline, Measure, MediaStage, Page, Pane, Panes, Split, Stack, Stage, Stat, StatusLine, Text, Thumb, Tiles, TitleBand, View, WebStage, ViewState, type Space, type ViewStateSpec } from "./frame.tsx";
export { formatTime, Scrubber, type ScrubberProps, type TrimRange } from "./media.tsx";
export { Ribbon, Timeline, TimelineEntry, type RibbonItem } from "./timeline.tsx";
export { DataGrid, type DataGridProps, type GridCell, type GridColumn, type GridSort, type GridRowInfo } from "./grid.tsx";
export { Chip, List, ListGroup, ListHeading, ListRow, ListRowActions, ListRowContent, ListRowEnd, ListRowIcon, ListSection, ListValue, Mark, Panel, PanelBody, PanelHeader, PanelSummary, Twisty, TwistySpace, type ListRowProps } from "./list.tsx";
export { ICON, Icon, UIProvider, iconNode, type IconProps, type IconWeight } from "./icon.tsx";
export { Callout, Card, Checklist, CodeBlock, Diff, EmptyState, FeatureList, FormActions, FormRow, FormSection, Group, InfoButton, KeyValue, Prose, QrCode, ResetButton, SectionHeading, Separator, SheetHeader, Spacer, Toolbar, type Step, type StepState } from "./layout.tsx";
export { ConfirmDialog, Dialog, DialogLayer, Menu, Popover, Presence, Toast, Toaster, dismissToast, placePopover, toast, type Align, type MenuItemProps, type ToastOptions } from "./overlay.tsx";
export { Badge, Kbd, LiveBadge, PageDots, Progress, ProgressRing, Spinner, StatusDot, type DotState, type Tone } from "./status.tsx";
export { installScrollbars, scrollbarScript, scrolled, scrollbarsMoved, watchScrollbars, PAGE_SCROLLBAR_CSS, SCROLLBAR_CSS, SCROLLBAR_HOLD, type ScrollbarsOptions } from "./scrollbars.ts";
export { displayAddress, ToolbarAddressField, ToolbarButton, ToolbarField, ToolbarSearchField, ToolbarGroup, ToolbarMenu, ToolbarPath, ToolbarSegmented, ToolbarSeparator, ToolbarSpacer, ToolbarText, WindowToolbar, type ToolbarButtonProps, type ToolbarFieldProps } from "./toolbar.tsx";
export { EASE, EASE_EXIT, glide, GLIDE_EASING, GLIDE_MS, glideNow, MOTION, tween, reducedMotion, slide, spring, timing, useFlip, usePresence, usePresentValue } from "./motion.ts";
export { ErrorBoundary, type ErrorBoundaryProps } from "./boundary.tsx";
export { Window, WindowBar, WindowBarMenu, WindowBody, WindowFrame } from "./window.tsx";
export { installTooltips, placeTip, useTooltip, type TipSide } from "./tooltips.tsx";
export { Tree, TreeHeader, TreeRename, TreeRow, type TreeRowProps, type TreeSort, type TreeTone } from "./tree.tsx";
