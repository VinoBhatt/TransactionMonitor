export type RawRow = Record<string, unknown>

export type Transaction = {
  sourceRow: number
  noteId: string
  name: string
  userType: string
  bank: string
  accountNo: string
  amount: number
  transactionNo: string
  dateRaw: string
  date: Date | null
  payVia: string
  action: string
}

export type RuleId = 'TM-001' | 'TM-002' | 'TM-003' | 'TM-004' | 'TM-005' | 'TM-006'

export type Flag = {
  id: string
  monthKey: string
  investorKey: string
  investorName: string
  investorId?: string
  riskProfile?: string
  activeStatus?: string
  historicalAverageDeposit?: number
  historicalMaxDeposit?: number
  priorComplianceContext?: string
  ruleId: RuleId
  ruleName: string
  severity: 'Routine' | 'Medium' | 'High'
  amount: number
  transactionCount: number
  reason: string
  transactionRows: number[]
}

export type ReviewDecision = 'Pending' | 'Cleared' | 'Request Information' | 'Escalated'

export type ReviewRecord = {
  flagId: string
  decision: ReviewDecision
  comments: string
  reviewedBy: string
  reviewedAt: string
}

export type StaffMember = {
  id: string
  name: string
  email?: string
  identifier?: string
  active: boolean
}

export type NoteMasterRow = {
  noteId: string
  referenceId: string
  noteName: string
}

export type RuleConfig = {
  id: RuleId
  name: string
  description: string
  enabled: boolean
  locked: boolean
  threshold?: number
}

export type HistoricalInvestor = {
  investorId: string
  name: string
  dateOnboarded?: string
  riskProfile?: string
  activeStatus?: string
  accountBalance?: number
  monthlyDeposits: Record<string, number>
  monthlyInvestments: Record<string, number>
  monthlyWithdrawals: Record<string, number>
}

export type PriorComplianceContext = {
  investorId?: string
  name: string
  comments: string
}
