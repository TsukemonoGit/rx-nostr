import Nostr from "nostr-typedef";
import {
  filter,
  finalize,
  first,
  identity,
  map,
  merge,
  mergeAll,
  Observable,
  type OperatorFunction,
  pipe,
  ReplaySubject,
  Subject,
  take,
  takeUntil,
  tap,
  timeout,
  type Unsubscribable,
} from "rxjs";

import { makeRxNostrConfig, type RxNostrConfig } from "./config.js";
import { NostrConnection } from "./connection/index.js";
import {
  RxNostrAlreadyDisposedError,
  RxNostrInvalidUsageError,
  RxNostrLogicError,
} from "./error.js";
import { getSignedEvent } from "./nostr/event.js";
import { completeOnTimeout } from "./operator.js";
import type {
  ConnectionState,
  ConnectionStatePacket,
  ErrorPacket,
  EventPacket,
  LazyFilter,
  LazyREQ,
  MessagePacket,
  OkPacket,
} from "./packet.js";
import type { RxReq } from "./req.js";
import {
  defineDefault,
  inlineThrow,
  normalizeRelayUrl,
  subtract,
} from "./util.js";

/**
 * The core object of rx-nostr, which holds a connection to relays
 * and manages subscriptions as directed by the RxReq object connected by `use()`.
 * Use `createRxNostr()` to get the object.
 */
export interface RxNostr {
  /** @deprecated Use getDefaultRelays */
  getRelays(): DefaultRelayConfig[];

  /** @deprecated Use `setDefaultRelays()` instead. */
  switchRelays(config: AcceptableDefaultRelaysConfig): Promise<void>;
  /** @deprecated Use `addDefaultRelays()` instead. */
  addRelay(relay: string | DefaultRelayConfig): Promise<void>;
  /** @deprecated Use `removeDefaultRelays()` instead. */
  removeRelay(url: string): Promise<void>;

  /** @deprecated Use `getDefaultRelay(url) !== undefined` instead. */
  hasRelay(url: string): boolean;
  /** @deprecated Use `getDefaultRelay(url)?.write` instead. */
  canWriteRelay(url: string): boolean;
  /** @deprecated Use `getDefaultRelay(url)?.read` instead. */
  canReadRelay(url: string): boolean;

  /**
   * Return config objects of the default relays used by this object.
   * The relay URLs are normalised so may not match the URLs set.
   *
   * **NOTE**:
   * The record's keys are **normalized** URL, so may be different from ones you set.
   * Use `getDefaultRelay(url)` instead to ensure that you get the value associated with a given URL.
   */
  getDefaultRelays(): Record<string, DefaultRelayConfig>;
  /**
   * Return a config object of the given relay if it exists.
   */
  getDefaultRelay(url: string): DefaultRelayConfig | undefined;

  /**
   * Set the list of default relays. Existing default relays **will be overwritten**.
   *
   * If a REQ subscription for default relays already exists,
   * the same REQ will be issued for the newly added relay
   * and CLOSE will be sent for the removed relay.
   */
  setDefaultRelays(relays: AcceptableDefaultRelaysConfig): void;
  /** Utility wrapper for `setDefaultRelays()`. */
  addDefaultRelays(relays: AcceptableDefaultRelaysConfig): void;
  /** Utility wrapper for `setDefaultRelays()`. */
  removeDefaultRelays(urls: string | string[]): void;

  /**
   * Return connection status of all default relays and all relays that RxNostr has used temporary.
   *
   * **NOTE**:
   * Keys are **normalized** URL, so may be different from ones you set.
   * Use `getRelayState(url)` instead to ensure that you get the value associated with a given URL.
   */
  getAllRelayState(): Record<string, ConnectionState>;
  /**
   * Return connection state of the given relay if it exists.
   */
  getRelayState(url: string): ConnectionState | undefined;
  /**
   * Attempt to reconnect manually if its connection state is `error` or `rejected`.
   *
   * If not, do nothing.
   */
  reconnect(url: string): void;

  /**
   * Associate RxReq with RxNostr.
   *
   * When the associated RxReq is manipulated, the RxNostr sends a new REQ to relays.
   * This method returns an Observable that emits the REQ query's responses.
   *
   * You can unsubscribe the Observable to send CLOSE.
   */
  use(
    rxReq: RxReq,
    options?: Partial<RxNostrUseOptions>
  ): Observable<EventPacket>;
  /**
   * Create an Observable that receives all events (EVENT) from all websocket connections.
   *
   * Nothing happens when this Observable is unsubscribed.
   * */
  createAllEventObservable(): Observable<EventPacket>;
  /**
   * Create an Observable that receives all errors from all websocket connections.
   *
   * Note that this method is the only way to receive errors arising from multiplexed websocket connections.
   * (It means that Observables returned by `use()` never throw error).
   *
   * Nothing happens when this Observable is unsubscribed.
   * */
  createAllErrorObservable(): Observable<ErrorPacket>;
  /**
   * Create an Observable that receives all messages from all websocket connections.
   *
   * Nothing happens when this Observable is unsubscribed.
   * */
  createAllMessageObservable(): Observable<MessagePacket>;
  /**
   * Create an Observable that receives changing of WebSocket connection state.
   *
   * Nothing happens when this Observable is unsubscribed.
   */
  createConnectionStateObservable(): Observable<ConnectionStatePacket>;

  /**
   * Attempt to send events to relays.
   *
   * The `seckey` option accepts both nsec format and hex format,
   * and if omitted NIP-07 will be automatically used.
   */
  send(
    params: Nostr.EventParameters,
    options?: RxNostrSendOptions
  ): Observable<OkPacket>;

  /**
   * Release all resources held by the RxNostr object.
   *
   * Any Observable resulting from this RxNostr will be in the completed state
   * and will never receive messages again.
   * RxReq used by this object is not affected; in other words, if the RxReq is used
   * by another RxNostr, its use is not prevented.
   */
  dispose(): void;
}

/** Create a RxNostr object. This is the only way to create that. */
export function createRxNostr(config?: Partial<RxNostrConfig>): RxNostr {
  return new RxNostrImpl(makeRxNostrConfig(config));
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface RxNostrUseOptions {}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _makeRxNostrUseOptions = defineDefault<RxNostrUseOptions>({});

export interface RxNostrSendOptions {
  seckey?: string;
}
const makeRxNostrSendOptions = defineDefault<RxNostrSendOptions>({
  seckey: undefined,
});

/** Config object specifying default relays' behaviors. */
export interface DefaultRelayConfig {
  /** WebSocket endpoint URL. */
  url: string;
  /** If true, rxNostr can publish REQ and subscribe EVENTs. */
  read: boolean;
  /** If true, rxNostr can send EVENTs. */
  write: boolean;
}
/** @deprecated Use `DefaultRelayConfig` instead.  */
export type RelayConfig = DefaultRelayConfig;

/** Parameter of `rxNostr.setDefaultRelays()` */
export type AcceptableDefaultRelaysConfig =
  | (
      | string
      | string[] /* ["r", url: string, mode?: "read" | "write"] */
      | DefaultRelayConfig
    )[]
  | Nostr.Nip07.GetRelayResult;
/** @deprecated Use `AcceptableDefaultRelaysConfig` instead. */
export type AcceptableRelaysConfig = AcceptableDefaultRelaysConfig;

class RxNostrImpl implements RxNostr {
  private connections = new Map<string, NostrConnection>();
  private getConnections(urls: string[]): NostrConnection[] {
    const conns: NostrConnection[] = [];

    for (const url of new Set(urls.map(normalizeRelayUrl))) {
      const conn = this.connections.get(url);
      if (conn) {
        conns.push(conn);
      }
    }

    return conns;
  }

  private defaultRelays: Record<string, DefaultRelayConfig> = {};
  private get defaultReadRelays(): string[] {
    return Object.values(this.defaultRelays)
      .filter(({ read }) => read)
      .map(({ url }) => url);
  }
  private get defaultWriteRelays(): string[] {
    return Object.values(this.defaultRelays)
      .filter(({ write }) => write)
      .map(({ url }) => url);
  }
  private weakReqs: Map<string, LazyREQ> = new Map();

  private event$ = new Subject<MessagePacket<Nostr.ToClientMessage.EVENT>>();
  private eose$ = new Subject<MessagePacket<Nostr.ToClientMessage.EOSE>>();
  private ok$ = new Subject<MessagePacket<Nostr.ToClientMessage.OK>>();
  private other$ = new Subject<MessagePacket<Nostr.ToClientMessage.Any>>();

  private error$ = new Subject<ErrorPacket>();
  private connectionState$ = new Subject<ConnectionStatePacket>();

  private dispose$ = new Subject<void>();
  private disposed = false;

  constructor(private config: RxNostrConfig) {}

  getRelays(): DefaultRelayConfig[] {
    return Object.values(this.getDefaultRelays());
  }

  async switchRelays(config: AcceptableDefaultRelaysConfig): Promise<void> {
    return this.setDefaultRelays(config);
  }
  async addRelay(relay: string | DefaultRelayConfig): Promise<void> {
    await this.switchRelays([...this.getRelays(), relay]);
  }
  async removeRelay(url: string): Promise<void> {
    const u = normalizeRelayUrl(url);
    const currentRelays = this.getRelays();
    const nextRelays = currentRelays.filter((relay) => relay.url !== u);
    if (currentRelays.length !== nextRelays.length) {
      await this.switchRelays(nextRelays);
    }
  }

  hasRelay(url: string): boolean {
    return !!this.getDefaultRelay(url);
  }
  canReadRelay(url: string): boolean {
    return !!this.getDefaultRelay(url)?.read;
  }
  canWriteRelay(url: string): boolean {
    return !!this.getDefaultRelay(url)?.write;
  }

  getDefaultRelays(): Record<string, DefaultRelayConfig> {
    if (this.disposed) {
      throw new RxNostrAlreadyDisposedError();
    }

    return this.defaultRelays;
  }
  getDefaultRelay(url: string): DefaultRelayConfig | undefined {
    return this.defaultRelays[normalizeRelayUrl(url)];
  }

  setDefaultRelays(relays: AcceptableDefaultRelaysConfig): void {
    if (this.disposed) {
      throw new RxNostrAlreadyDisposedError();
    }

    const defaultRelays = normalizeRelaysConfig(relays);
    for (const url of Object.keys(defaultRelays)) {
      if (!this.connections.has(url)) {
        this.connectObservables(url);
      }
    }

    const defaultReadRelays = Object.values(defaultRelays)
      .filter(({ read }) => read)
      .map(({ url }) => url);
    this.switchWeakSubs(defaultReadRelays);

    this.defaultRelays = defaultRelays;
  }
  private switchWeakSubs(defaultReadRelays: string[]): void {
    const noLongerNeeded = subtract(this.defaultReadRelays, defaultReadRelays);

    for (const conn of this.getConnections(noLongerNeeded)) {
      conn.setKeepWeakSubs(false);
    }
    for (const conn of this.getConnections(defaultReadRelays)) {
      conn.setKeepWeakSubs(true);
      for (const req of this.weakReqs.values()) {
        conn?.subscribe(req, {
          mode: "weak",
          overwrite: false,
        });
      }
    }
  }
  private connectObservables(url: string): void {
    const oldConn = this.connections.get(url);
    if (oldConn) {
      oldConn.dispose();
    }

    const conn = new NostrConnection(url, this.config);

    conn.getEventObservable().subscribe(this.event$);
    conn.getEoseObservable().subscribe(this.eose$);
    conn.getOkObservable().subscribe(this.ok$);
    conn.getOtherObservable().subscribe(this.other$);
    conn.getConnectionStateObservable().subscribe(this.connectionState$);
    conn.getErrorObservable().subscribe(this.error$);

    this.connections.set(url, conn);
  }
  addDefaultRelays(relays: AcceptableDefaultRelaysConfig): void {
    const additionalDefaultRelays = normalizeRelaysConfig(relays);

    this.setDefaultRelays({
      ...this.defaultRelays,
      ...additionalDefaultRelays,
    });
  }
  removeDefaultRelays(urls: string | string[]): void {
    const defaultRelays = this.defaultRelays;
    const targets = Array.isArray(urls) ? urls : [urls];
    for (const url of targets) {
      delete defaultRelays[url];
    }

    this.setDefaultRelays(defaultRelays);
  }

  getAllRelayState(): Record<string, ConnectionState> {
    return Object.fromEntries(
      Array.from(this.connections.values()).map((e) => [
        e.url,
        this.getRelayState(e.url) ?? inlineThrow(new RxNostrLogicError()),
      ])
    );
  }
  getRelayState(url: string): ConnectionState | undefined {
    const conn = this.connections.get(normalizeRelayUrl(url));
    if (!conn) {
      return undefined;
    }

    return conn.connectionState;
  }

  reconnect(url: string): void {
    const relay = this.getDefaultRelay(url);
    if (!relay) {
      throw new RxNostrInvalidUsageError(
        `The relay (${url}) is not a default relay. \`reconnect()\` can be used only for a readable default relay.`
      );
    }
    if (!relay.read) {
      throw new RxNostrInvalidUsageError(
        `The relay (${url}) is not readable. \`reconnect()\` can be used only for a readable default relay.`
      );
    }

    const conn = this.connections.get(normalizeRelayUrl(url));
    if (!conn) {
      throw new RxNostrLogicError();
    }
    if (
      conn.connectionState === "error" ||
      conn.connectionState === "rejected"
    ) {
      conn.connectManually();
    }
  }
  use(
    rxReq: RxReq,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options?: Partial<RxNostrUseOptions>
  ): Observable<EventPacket> {
    const targetRelays = this.defaultReadRelays;
    const mode = "weak";

    const req$ = rxReq.getReqObservable().pipe(
      filter((filters): filters is LazyFilter[] => filters !== null),
      rxReq.strategy === "oneshot" ? first() : identity,
      makeReq(rxReq)
    );

    if (rxReq.strategy === "forward") {
      const subId = makeSubId({
        rxReqId: rxReq.rxReqId,
      });

      let x: Unsubscribable | null = null;

      // switchAll 使ったほうがいいかも
      return this.event$.pipe(
        takeUntil(this.dispose$),
        pickEvent(subId),
        tap({
          subscribe: () => {
            x = req$.subscribe((req) => {
              if (mode === "weak") {
                this.weakReqs.set(subId, req);
              }

              for (const conn of this.getConnections(targetRelays)) {
                conn.subscribe(req, {
                  mode,
                  overwrite: true,
                });
              }
            });
          },
          finalize: () => {
            if (mode === "weak") {
              this.weakReqs.delete(subId);
            }
            x?.unsubscribe();

            for (const conn of this.getConnections(targetRelays)) {
              conn.unsubscribe(subId);
            }
          },
        })
      );
    } else {
      const isDown = (state: ConnectionState): boolean =>
        state === "error" || state === "rejected" || state === "terminated";

      return req$.pipe(
        map((req) => {
          const subId = req[1];
          const eose$ = new Subject<void>();
          const complete$ = new Subject<void>();
          const eoseRelays = new Set<string>();
          const manageCompletion = merge(
            eose$,
            this.connectionState$.asObservable()
          )
            .pipe(
              filter(() => {
                const shouldComplete = this.getConnections(targetRelays).every(
                  ({ connectionState, url }) =>
                    isDown(connectionState) || eoseRelays.has(url)
                );

                return shouldComplete;
              })
            )
            .subscribe(() => {
              complete$.next();
            });

          this.eose$
            .pipe(filter(({ message }) => message[1] === subId))
            .subscribe(({ from }) => {
              eoseRelays.add(from);
              eose$.next();
            });

          if (mode === "weak") {
            this.weakReqs.set(subId, req);
          }
          for (const conn of this.getConnections(targetRelays)) {
            conn.subscribe(req, { overwrite: false, autoclose: true, mode });
          }

          return this.event$.pipe(
            takeUntil(complete$),
            completeOnTimeout(this.config.timeout),
            finalize(() => {
              if (mode === "weak") {
                this.weakReqs.delete(subId);
              }

              complete$.complete();
              eose$.complete();
              manageCompletion.unsubscribe();
            }),
            filter((e) => !eoseRelays.has(e.from)),
            pickEvent(subId)
          );
        }),
        mergeAll(),
        takeUntil(this.dispose$)
      );
    }
  }

  createAllEventObservable(): Observable<EventPacket> {
    return this.event$.pipe(
      map(({ from, message }) => ({
        from,
        subId: message[1],
        event: message[2],
      }))
    );
  }
  createAllErrorObservable(): Observable<ErrorPacket> {
    return this.error$.asObservable();
  }
  createAllMessageObservable(): Observable<MessagePacket> {
    return merge(
      this.event$.asObservable(),
      this.eose$.asObservable(),
      this.ok$.asObservable(),
      this.other$.asObservable()
    );
  }
  createConnectionStateObservable(): Observable<ConnectionStatePacket> {
    return this.connectionState$.asObservable();
  }

  send(
    params: Nostr.EventParameters,
    options?: RxNostrSendOptions
  ): Observable<OkPacket> {
    const { seckey } = makeRxNostrSendOptions(options);

    const targetRelays = this.defaultWriteRelays;
    const subject = new ReplaySubject<OkPacket>(targetRelays.length);

    const teardown = () => {
      if (!subject.closed) {
        subject.complete();
      }
    };

    getSignedEvent(params, seckey)
      .then((event) => {
        if (subject.closed) {
          return;
        }

        this.ok$
          .pipe(
            filter(({ message: [, eventId] }) => eventId === event.id),
            map(({ from, message: [, id, ok] }) => ({ from, id, ok }))
          )
          .subscribe(subject);

        for (const conn of this.getConnections(targetRelays)) {
          conn.publish(event);
        }
      })
      .catch((err) => {
        teardown();

        throw new RxNostrInvalidUsageError(
          err instanceof Error ? err.message : "Failed to sign the given event"
        );
      });

    return subject.pipe(
      take(targetRelays.length),
      takeUntil(this.dispose$),
      // TODO: config
      timeout(30 * 1000),
      finalize(teardown)
    );
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    for (const conn of this.connections.values()) {
      conn.dispose();
    }
    this.connections.clear();

    const subjects = [
      this.event$,
      this.ok$,
      this.eose$,
      this.other$,
      this.connectionState$,
      this.error$,
    ];
    for (const sub of subjects) {
      sub.complete();
    }

    this.dispose$.next();
    this.dispose$.complete();
  }
}

function makeSubId(params: { rxReqId: string; index?: number }): string {
  return `${params.rxReqId}:${params.index ?? 0}`;
}

function makeReq({
  rxReqId,
  strategy,
}: RxReq): OperatorFunction<LazyFilter[], LazyREQ> {
  const makeId = (index?: number) => makeSubId({ rxReqId, index });

  switch (strategy) {
    case "backward":
      return map((filters, index) => ["REQ", makeId(index), ...filters]);
    case "forward":
    case "oneshot":
      return map((filters) => ["REQ", makeId(), ...filters]);
  }
}

function pickEvent(
  subId: string
): OperatorFunction<MessagePacket<Nostr.ToClientMessage.EVENT>, EventPacket> {
  return pipe(
    filter(({ message }) => message[1] === subId),
    map(({ from, message }) => ({
      from,
      subId: message[1],
      event: message[2],
    }))
  );
}

function normalizeRelaysConfig(
  config: AcceptableDefaultRelaysConfig
): Record<string, DefaultRelayConfig> {
  if (Array.isArray(config)) {
    const arr = config.map((urlOrConfig) => {
      let url = "";
      let read = false;
      let write = false;
      if (typeof urlOrConfig === "string") {
        url = urlOrConfig;
        read = true;
        write = true;
      } else if (Array.isArray(urlOrConfig)) {
        const mode = urlOrConfig[2];
        url = urlOrConfig[1];
        read = !mode || mode === "read";
        write = !mode || mode === "write";
      } else {
        url = urlOrConfig.url;
        read = urlOrConfig.read;
        write = urlOrConfig.write;
      }

      return {
        url: normalizeRelayUrl(url),
        read,
        write,
      };
    });

    return Object.fromEntries(arr.map((e) => [e.url, e]));
  } else {
    const arr = Object.entries(config).map(([url, flags]) => ({
      url: normalizeRelayUrl(url),
      ...flags,
    }));

    return Object.fromEntries(arr.map((e) => [e.url, e]));
  }
}
