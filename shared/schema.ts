import { z } from 'zod'

const text = z.string().max(10000)
const name = z.string().trim().min(1).max(500)
const monthly = z.record(z.string(), z.number().finite())
export const transactionSchema = z.object({
  sourceRow:z.number().int().nonnegative(), noteId:text, name,
  userType:text, bank:text, accountNo:text, amount:z.number().finite(),
  transactionNo:text, dateRaw:text, date:z.iso.datetime().nullable(), payVia:text, action:name,
})
export const staffSchema = z.object({id:name,name,email:text.optional(),identifier:text.optional(),active:z.boolean()})
export const historySchema = z.object({investorId:text,name,dateOnboarded:text.optional(),riskProfile:text.optional(),activeStatus:text.optional(),accountBalance:z.number().finite().optional(),monthlyDeposits:monthly,monthlyInvestments:monthly,monthlyWithdrawals:monthly})
export const noteSchema = z.object({noteId:name,referenceId:text,noteName:text})
export const contextSchema = z.object({investorId:text.optional(),name,comments:text})
export const ruleSchema = z.object({id:z.enum(['TM-001','TM-002','TM-003','TM-004','TM-005','TM-006']),name,description:text,enabled:z.boolean(),locked:z.boolean(),threshold:z.number().finite().nonnegative().optional()}).transform(r=>r.id==='TM-001'?{...r,enabled:true,locked:true,threshold:30000}:{...r,locked:false})
export const reviewSchema = z.object({flagId:name,decision:z.enum(['Pending','Cleared','Request Information','Escalated']),comments:text,reviewedBy:name,reviewedAt:z.iso.datetime()})
export const signoffSchema = z.object({month:z.string().regex(/^\d{4}-\d{2}$/),reviewedBy:name,designation:name,comments:text,status:z.enum(['Pending','Completed']),updatedAt:z.iso.datetime()})
export type Signoff = z.infer<typeof signoffSchema>
export function schemaFor(dataset:string) {
  if (/^transactions:\d{4}-(0[1-9]|1[0-2])$/.test(dataset)) return transactionSchema
  if (/^review:.{1,500}$/.test(dataset)) return reviewSchema
  if (/^signoff:\d{4}-(0[1-9]|1[0-2])$/.test(dataset)) return signoffSchema
  return ({staff:staffSchema,history:historySchema,notes:noteSchema,context:contextSchema,rules:ruleSchema} as Record<string,z.ZodType>)[dataset]
}
