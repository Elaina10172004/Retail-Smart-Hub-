export type AiToolCallStatus = 'planned' | 'disabled' | 'completed' | 'awaiting_confirmation' | 'cancelled' | 'reverted';

export type ReadOnlyToolName =
  | 'get_dashboard_overview'
  | 'list_orders'
  | 'get_order_detail'
  | 'get_procurement_detail'
  | 'get_inventory_overview'
  | 'list_inventory_alerts'
  | 'query_inventory_item'
  | 'get_reports_overview'
  | 'list_procurement_orders'
  | 'list_procurement_suggestions'
  | 'get_finance_overview'
  | 'get_receivable_detail'
  | 'list_receivables'
  | 'list_receipt_records'
  | 'get_payable_detail'
  | 'list_payables'
  | 'list_payment_records'
  | 'list_customers'
  | 'get_customer_detail'
  | 'get_customer_summary'
  | 'list_audit_logs'
  | 'get_role_template_guide'
  | 'get_security_level_guide'
  | 'get_audit_definition'
  | 'get_report_definitions'
  | 'get_api_catalog'
  | 'get_database_table_detail'
  | 'get_access_overview'
  | 'get_master_data_overview'
  | 'get_password_policy'
  | 'get_password_security'
  | 'list_user_sessions'
  | 'get_arrival_detail'
  | 'list_arrivals'
  | 'get_inbound_detail'
  | 'list_inbounds'
  | 'get_shipment_detail'
  | 'list_shipments'
  | 'list_system_notifications'
  | 'get_profile_memory'
  | 'list_memory_facts';

export interface ReadOnlyToolDescriptor {
  name: ReadOnlyToolName;
  description: string;
  requiredPermissions: string[];
}

export interface AiToolCallRecord {
  name: ReadOnlyToolName | string;
  status: AiToolCallStatus;
  summary: string;
}

export interface AiPendingAction {
  id: string;
  name: string;
  summary: string;
  confirmationMessage: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'undone' | 'expired';
  createdAt: string;
  expiresAt: string;
  canUndo?: boolean;
  undoneAt?: string;
}

export interface AiApproval {
  id: string;
  kind: 'write_action';
  toolName: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'undone' | 'expired';
  resumable: boolean;
  canConfirm: boolean;
  canCancel: boolean;
  canUndo: boolean;
  confirmPath: string;
  cancelPath: string;
  undoPath?: string;
  expiresAt: string;
  summary: string;
  confirmationMessage: string;
}

export interface ReadOnlyToolExecutionResult {
  toolCalls: AiToolCallRecord[];
  toolContext: string;
}
