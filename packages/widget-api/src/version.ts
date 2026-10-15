// The API this build of @cmd/widget-api speaks, sent in the process's hello. The same
// numbers as the protocol's WIDGET_API and WIDGET_API_MINOR (test/contract.test.ts holds
// them equal); copied, so the bundle the widget process loads carries nothing of protocol.

/** The API major. @since 1.0 */
export const WIDGET_API = 1;
/** The API minor: 1 since the acts and `cmd.run` came (1.1), 2 since the window-content elements (1.2). @since 1.0 */
export const WIDGET_API_MINOR = 2;
