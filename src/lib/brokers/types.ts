// Broker-independent trading contract. The Danscom strategy engine emits
// TradeSignal objects; a BrokerProvider translates them for a specific broker.
// Adding a new broker means implementing this interface — the strategy and the
// risk-management layer never change.

export type BrokerId = "capital" | "mt5";

export type TradeSignal = {
  symbol: string; // logical symbol, e.g. "XAUUSD"
  side: "buy" | "sell";
  volume: number; // lots (MT5) / size (Capital.com)
  stop_loss?: number | null; // absolute price
  take_profit?: number | null; // absolute price
  comment?: string;
};

export type BrokerAccountSummary = {
  broker: BrokerId;
  environment: string; // "demo" | "live" | mt5 server name
  connected: boolean;
  accountLabel: string | null;
  currency: string | null;
  balance: number | null;
  equity: number | null;
  available: number | null;
  profit: number | null;
};

export type BrokerExecutionResult = {
  ok: boolean;
  reference: string | null;
  detail: string | null;
};

export interface BrokerProvider {
  id: BrokerId;
  /** Send a broker-independent signal to this broker. */
  execute(signal: TradeSignal): Promise<BrokerExecutionResult>;
  /** Close a single open position by its broker-specific identifier. */
  close(positionRef: string): Promise<BrokerExecutionResult>;
}