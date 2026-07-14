export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      account_snapshots: {
        Row: {
          account_id: string
          balance: number | null
          captured_at: string
          currency: string | null
          equity: number | null
          free_margin: number | null
          id: number
          margin: number | null
          margin_level: number | null
          profit: number | null
          user_id: string
        }
        Insert: {
          account_id: string
          balance?: number | null
          captured_at?: string
          currency?: string | null
          equity?: number | null
          free_margin?: number | null
          id?: number
          margin?: number | null
          margin_level?: number | null
          profit?: number | null
          user_id: string
        }
        Update: {
          account_id?: string
          balance?: number | null
          captured_at?: string
          currency?: string | null
          equity?: number | null
          free_margin?: number | null
          id?: number
          margin?: number | null
          margin_level?: number | null
          profit?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_snapshots_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "mt5_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      activity_logs: {
        Row: {
          account_id: string | null
          created_at: string
          data: Json | null
          id: number
          level: string
          message: string
          source: string
          user_id: string
        }
        Insert: {
          account_id?: string | null
          created_at?: string
          data?: Json | null
          id?: number
          level?: string
          message: string
          source?: string
          user_id: string
        }
        Update: {
          account_id?: string | null
          created_at?: string
          data?: Json | null
          id?: number
          level?: string
          message?: string
          source?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_logs_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "mt5_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      bridge_commands: {
        Row: {
          account_id: string
          command: string
          created_at: string
          id: string
          payload: Json
          processed_at: string | null
          result: Json | null
          status: string
          user_id: string
        }
        Insert: {
          account_id: string
          command: string
          created_at?: string
          id?: string
          payload?: Json
          processed_at?: string | null
          result?: Json | null
          status?: string
          user_id: string
        }
        Update: {
          account_id?: string
          command?: string
          created_at?: string
          id?: string
          payload?: Json
          processed_at?: string | null
          result?: Json | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bridge_commands_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "mt5_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      mt5_accounts: {
        Row: {
          bridge_token: string | null
          bridge_url: string | null
          broker: string
          connection_status: string
          created_at: string
          id: string
          is_active: boolean
          label: string
          last_seen_at: string | null
          login: string
          password_ciphertext: string
          server: string
          updated_at: string
          user_id: string
        }
        Insert: {
          bridge_token?: string | null
          bridge_url?: string | null
          broker: string
          connection_status?: string
          created_at?: string
          id?: string
          is_active?: boolean
          label: string
          last_seen_at?: string | null
          login: string
          password_ciphertext: string
          server: string
          updated_at?: string
          user_id: string
        }
        Update: {
          bridge_token?: string | null
          bridge_url?: string | null
          broker?: string
          connection_status?: string
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string
          last_seen_at?: string | null
          login?: string
          password_ciphertext?: string
          server?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      pending_orders: {
        Row: {
          account_id: string
          id: string
          placed_at: string | null
          price: number | null
          stop_loss: number | null
          symbol: string
          take_profit: number | null
          ticket: number
          type: string
          updated_at: string
          user_id: string
          volume: number
        }
        Insert: {
          account_id: string
          id?: string
          placed_at?: string | null
          price?: number | null
          stop_loss?: number | null
          symbol: string
          take_profit?: number | null
          ticket: number
          type: string
          updated_at?: string
          user_id: string
          volume: number
        }
        Update: {
          account_id?: string
          id?: string
          placed_at?: string | null
          price?: number | null
          stop_loss?: number | null
          symbol?: string
          take_profit?: number | null
          ticket?: number
          type?: string
          updated_at?: string
          user_id?: string
          volume?: number
        }
        Relationships: [
          {
            foreignKeyName: "pending_orders_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "mt5_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      positions: {
        Row: {
          account_id: string
          current_price: number | null
          id: string
          open_price: number | null
          opened_at: string | null
          profit: number | null
          side: string
          stop_loss: number | null
          swap: number | null
          symbol: string
          take_profit: number | null
          ticket: number
          updated_at: string
          user_id: string
          volume: number
        }
        Insert: {
          account_id: string
          current_price?: number | null
          id?: string
          open_price?: number | null
          opened_at?: string | null
          profit?: number | null
          side: string
          stop_loss?: number | null
          swap?: number | null
          symbol: string
          take_profit?: number | null
          ticket: number
          updated_at?: string
          user_id: string
          volume: number
        }
        Update: {
          account_id?: string
          current_price?: number | null
          id?: string
          open_price?: number | null
          opened_at?: string | null
          profit?: number | null
          side?: string
          stop_loss?: number | null
          swap?: number | null
          symbol?: string
          take_profit?: number | null
          ticket?: number
          updated_at?: string
          user_id?: string
          volume?: number
        }
        Relationships: [
          {
            foreignKeyName: "positions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "mt5_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      strategies: {
        Row: {
          account_id: string
          created_at: string
          enabled: boolean
          id: string
          lot_size: number
          max_daily_loss: number | null
          max_open_trades: number
          name: string
          rule_params: Json
          rule_type: string
          stop_loss_pips: number | null
          symbol: string
          take_profit_pips: number | null
          timeframe: string
          trailing_stop_pips: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          account_id: string
          created_at?: string
          enabled?: boolean
          id?: string
          lot_size?: number
          max_daily_loss?: number | null
          max_open_trades?: number
          name: string
          rule_params?: Json
          rule_type: string
          stop_loss_pips?: number | null
          symbol: string
          take_profit_pips?: number | null
          timeframe?: string
          trailing_stop_pips?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          account_id?: string
          created_at?: string
          enabled?: boolean
          id?: string
          lot_size?: number
          max_daily_loss?: number | null
          max_open_trades?: number
          name?: string
          rule_params?: Json
          rule_type?: string
          stop_loss_pips?: number | null
          symbol?: string
          take_profit_pips?: number | null
          timeframe?: string
          trailing_stop_pips?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "strategies_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "mt5_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      trade_history: {
        Row: {
          account_id: string
          close_price: number | null
          closed_at: string | null
          commission: number | null
          created_at: string
          id: string
          open_price: number | null
          opened_at: string | null
          profit: number | null
          side: string
          strategy_id: string | null
          swap: number | null
          symbol: string
          ticket: number
          user_id: string
          volume: number
        }
        Insert: {
          account_id: string
          close_price?: number | null
          closed_at?: string | null
          commission?: number | null
          created_at?: string
          id?: string
          open_price?: number | null
          opened_at?: string | null
          profit?: number | null
          side: string
          strategy_id?: string | null
          swap?: number | null
          symbol: string
          ticket: number
          user_id: string
          volume: number
        }
        Update: {
          account_id?: string
          close_price?: number | null
          closed_at?: string | null
          commission?: number | null
          created_at?: string
          id?: string
          open_price?: number | null
          opened_at?: string | null
          profit?: number | null
          side?: string
          strategy_id?: string | null
          swap?: number | null
          symbol?: string
          ticket?: number
          user_id?: string
          volume?: number
        }
        Relationships: [
          {
            foreignKeyName: "trade_history_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "mt5_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trade_history_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
