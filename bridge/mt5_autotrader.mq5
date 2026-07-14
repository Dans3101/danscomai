//+------------------------------------------------------------------+
//|                                            mt5_autotrader.mq5    |
//|         Lightweight EA companion for the AutoTrader bridge.      |
//|                                                                  |
//|  Writes tick + account snapshots to <Common>\Files\autotrader\   |
//|  which the Python bridge tails when running headless.            |
//+------------------------------------------------------------------+
#property strict

input int   TickIntervalMs = 250;
input string OutputSubdir  = "autotrader";

datetime lastFlush = 0;

int OnInit() {
   EventSetMillisecondTimer(TickIntervalMs);
   Print("[AutoTrader EA] started");
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason) {
   EventKillTimer();
}

void OnTimer() {
   string path = OutputSubdir + "\\snapshot.json";
   int h = FileOpen(path, FILE_WRITE|FILE_TXT|FILE_COMMON|FILE_ANSI);
   if(h == INVALID_HANDLE) return;

   string body = StringFormat(
      "{\"ts\":%I64d,\"balance\":%.2f,\"equity\":%.2f,\"margin\":%.2f,\"free_margin\":%.2f,\"profit\":%.2f,\"currency\":\"%s\"}",
      (long)TimeCurrent(),
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
      AccountInfoDouble(ACCOUNT_MARGIN),
      AccountInfoDouble(ACCOUNT_MARGIN_FREE),
      AccountInfoDouble(ACCOUNT_PROFIT),
      AccountInfoString(ACCOUNT_CURRENCY)
   );

   FileWriteString(h, body);
   FileClose(h);
}

void OnTick() {
   // No-op: OnTimer is authoritative so we don't depend on any single chart.
}