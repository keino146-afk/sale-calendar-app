
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {

  "public": {
          Tables: {
            "admin_users": {
                  Row: {
                    "created_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"user_id"?: string
                  }
                  Relationships: [

                  ]
                },"collection_candidates": {
                  Row: {
                    "content_hash": string,"description": string | null,"ends_at": string,"evidence_excerpt": string,"external_key": string,"first_seen_at": string,"id": string,"imported_sale_event_id": string | null,"is_date_only": boolean,"last_seen_at": string,"last_seen_content_hash": string,"parser_version": string,"retailer_id": string,"review_state": string,"source_changed": boolean,"source_checked_at": string,"source_id": string,"source_url": string,"starts_at": string,"title": string
                  }
                  ComputedFields: never
                  Insert: {
                    "content_hash": string,"description"?: string | null,"ends_at": string,"evidence_excerpt": string,"external_key": string,"first_seen_at"?: string,"id"?: string,"imported_sale_event_id"?: string | null,"is_date_only": boolean,"last_seen_at"?: string,"last_seen_content_hash": string,"parser_version": string,"retailer_id": string,"review_state"?: string,"source_changed"?: boolean,"source_checked_at": string,"source_id": string,"source_url": string,"starts_at": string,"title": string
                  }
                  Update: {
                    "content_hash"?: string,"description"?: string | null,"ends_at"?: string,"evidence_excerpt"?: string,"external_key"?: string,"first_seen_at"?: string,"id"?: string,"imported_sale_event_id"?: string | null,"is_date_only"?: boolean,"last_seen_at"?: string,"last_seen_content_hash"?: string,"parser_version"?: string,"retailer_id"?: string,"review_state"?: string,"source_changed"?: boolean,"source_checked_at"?: string,"source_id"?: string,"source_url"?: string,"starts_at"?: string,"title"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "collection_candidates_imported_sale_event_id_fkey"
      columns: ["imported_sale_event_id"]
isOneToOne: false
      referencedRelation: "sale_events"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "collection_candidates_retailer_id_fkey"
      columns: ["retailer_id"]
isOneToOne: false
      referencedRelation: "retailers"
      referencedColumns: ["id"]
    }
                  ]
                },"retailers": {
                  Row: {
                    "created_at": string,"id": string,"is_active": boolean,"name": string,"official_base_url": string,"slug": string,"sort_order": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"is_active"?: boolean,"name": string,"official_base_url": string,"slug": string,"sort_order"?: number,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"is_active"?: boolean,"name"?: string,"official_base_url"?: string,"slug"?: string,"sort_order"?: number,"updated_at"?: string
                  }
                  Relationships: [

                  ]
                },"sale_event_audit": {
                  Row: {
                    "action": string,"actor_user_id": string | null,"created_at": string,"id": number,"new_data": Json | null,"note": string | null,"old_data": Json | null,"sale_event_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_user_id"?: string | null,"created_at"?: string,"id"?: never,"new_data"?: Json | null,"note"?: string | null,"old_data"?: Json | null,"sale_event_id": string
                  }
                  Update: {
                    "action"?: string,"actor_user_id"?: string | null,"created_at"?: string,"id"?: never,"new_data"?: Json | null,"note"?: string | null,"old_data"?: Json | null,"sale_event_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "sale_event_audit_sale_event_id_fkey"
      columns: ["sale_event_id"]
isOneToOne: false
      referencedRelation: "sale_events"
      referencedColumns: ["id"]
    }
                  ]
                },"sale_events": {
                  Row: {
                    "archived_at": string | null,"created_at": string,"description": string | null,"ends_at": string,"id": string,"is_date_only": boolean,"published_at": string | null,"rejected_at": string | null,"retailer_id": string,"source_checked_at": string | null,"source_url": string,"start_date_jst": string,"starts_at": string,"status": string,"title": string,"title_key": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"created_at"?: string,"description"?: string | null,"ends_at": string,"id"?: string,"is_date_only"?: boolean,"published_at"?: string | null,"rejected_at"?: string | null,"retailer_id": string,"source_checked_at"?: string | null,"source_url": string,"start_date_jst": string,"starts_at": string,"status"?: string,"title": string,"title_key": string,"updated_at"?: string
                  }
                  Update: {
                    "archived_at"?: string | null,"created_at"?: string,"description"?: string | null,"ends_at"?: string,"id"?: string,"is_date_only"?: boolean,"published_at"?: string | null,"rejected_at"?: string | null,"retailer_id"?: string,"source_checked_at"?: string | null,"source_url"?: string,"start_date_jst"?: string,"starts_at"?: string,"status"?: string,"title"?: string,"title_key"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "sale_events_retailer_id_fkey"
      columns: ["retailer_id"]
isOneToOne: false
      referencedRelation: "retailers"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "archive_sale_event":
{ Args: { "p_id": string }; Returns: undefined
                           },
"current_user_is_admin":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"is_allowed_manual_source":
{ Args: { "p_hostname": string,"p_retailer_id": string,"p_source_url": string }; Returns: boolean
                           },
"publish_sale_event":
{ Args: { "p_id": string }; Returns: undefined
                           },
"reject_sale_event":
{ Args: { "p_id": string,"p_reason": string }; Returns: undefined
                           },
"reopen_sale_event":
{ Args: { "p_id": string }; Returns: undefined
                           },
"submit_collection_candidate":
{ Args: { "p_content_hash": string,"p_description": string,"p_ends_at": string,"p_evidence_excerpt": string,"p_external_key": string,"p_is_date_only": boolean,"p_parser_version": string,"p_retailer_id": string,"p_source_checked_at": string,"p_source_id": string,"p_source_url": string,"p_starts_at": string,"p_title": string }; Returns: string
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

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
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
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
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {

          }
        }
} as const
