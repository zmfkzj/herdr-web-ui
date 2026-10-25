/**
 * `/gui view` on this server's own panes (docs/pi-visual-tools.md): what a browser connection types or
 * submits into a pane may name the private desktop Pi opens, and a `/gui view` Pi logged right after a
 * connection's Enter (server/pi-visual/runs.ts) is told to that connection. The grants themselves belong
 * to createServer, which serves the desktops they open; a server without them runs as before.
 */
import { type GrantOrigin, type GuiViewGrants, GuiViewTyping } from "../pi-visual/grants.ts";
import { GuiViewRuns } from "../pi-visual/runs.ts";
import type { ViewerSystem } from "../pi-visual/viewers.ts";
import { type Client, connectionOf, send } from "./connections.ts";

/** What createServer gives the core for `/gui view`: its grants, how a pane's agent is told, and the run reads. */
export interface GuiViewOptions {
  grants: GuiViewGrants;
  /** whether the pane runs Pi (herdr's agent): only its Enters are watched */
  isPi: (paneId: string) => Promise<boolean>;
  /** the processes and gui.log reads that confirm a `/gui view` Pi ran (server/pi-visual/runs.ts); tests give fixtures */
  runSystem?: ViewerSystem;
}

export interface GuiViews {
  /** text a connection typed into a pane's terminal, arrived at `at`: an Enter in it may run a `/gui view` */
  typed(client: Client, paneId: string, text: string, at: number): void;
  /** a message or an Enter a connection delivered to a pane, arrived at `at` */
  entered(client: Client, paneId: string, at: number): void;
  /** a message a connection submitted to a pane: a `/gui view <worker>` in it lets that browser open the desktop */
  submitted(client: Client, paneId: string, text: string): void;
  /** a connection whose device was revoked: what it ran opens nothing any more */
  revoked(client: Client): void;
  /** a closed connection */
  closed(client: Client): void;
  close(): void;
}

const NONE: GuiViews = { typed() {}, entered() {}, submitted() {}, revoked() {}, closed() {}, close() {} };

export function createGuiViews({ clients, visual }: { clients: Set<Client>; visual: GuiViewOptions | undefined }): GuiViews {
  if (!visual) return NONE;
  const { grants } = visual;
  /** who runs a command on this server's own panes: an interactive browser connection only */
  const originOf = (client: Client): GrantOrigin | null => {
    const state = connectionOf(client);
    return client.data.binding && !client.data.readOnly && !state.closing && state.mode === "interact"
      ? { binding: client.data.binding, ...(client.data.deviceId ? { deviceId: client.data.deviceId } : {}), machine: "local" } : null;
  };
  const typingOf = (client: Client) => client.data.guiTyping ??= new GuiViewTyping(grants, () => originOf(client));
  /**
   * `/gui view` that this pane's Pi logged right after a connection's Enter: the connection gets that
   * desktop's grant here, if it may open desktops here, and is told which desktop to open. A bridge's
   * connection server reads the same frame for its own browser (grants.ts).
   */
  const runs = new GuiViewRuns<Client>(visual.isPi, (client, paneId, worker, enteredAt) => {
    if (!clients.has(client) || connectionOf(client).closing || connectionOf(client).mode !== "interact") return;
    // a browser here: told only when its own keys did not already name that command (it opened the
    // desktop itself then). A connection server relaying for its browser has no grant here: it decides.
    const origin = originOf(client);
    if (origin && !grants.confirm(origin, paneId, worker, enteredAt - 1000)) return;
    send(client, { type: "gui-view", pane_id: paneId, worker });
  }, visual.runSystem);
  /** watched only while desktop viewing is on */
  const entered = (client: Client, paneId: string, at: number): void => {
    if (process.env["HERDR_PI_GUACD_ENABLED"] === "1" && connectionOf(client).mode === "interact") runs.entered(client, paneId, at);
  };
  return {
    typed(client, paneId, text, at) {
      typingOf(client).input(paneId, text);
      if (text.includes("\r")) entered(client, paneId, at);
    },
    entered,
    submitted(client, paneId, text) {
      const origin = originOf(client);
      if (origin) grants.observe(origin, paneId, text);
    },
    revoked(client) {
      const deviceId = client.data.deviceId;
      if (deviceId) grants.forget((grant) => grant.deviceId === deviceId);
    },
    closed(client) { runs.forget(client); },
    close() { runs.close(); },
  };
}
