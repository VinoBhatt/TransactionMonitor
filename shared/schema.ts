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
export const noteSchema = z.object({noteId:name,referenceId:text,noteName:text,noteType:text.optional(),issuer:text.optional(),financingAmount:z.number().finite().optional(),status:text.optional()})
export const investorSchema = z.object({investorId:name,refId:text.optional(),name,dateRegistered:text.optional(),email:text.optional(),balance:z.number().finite().optional(),status:text.optional()})
export const profileSchema = z.object({investorId:name,name,customerType:z.enum(['Retail','Corporate']),businessName:text.optional(),nationality:text.optional(),sourceOfFunds:text.optional(),natureOfJob:text.optional(),netWorth:text.optional(),grossIncome:text.optional(),kycStatus:text.optional(),riskRating:text.optional(),nextReviewDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()})
export const contextSchema = z.object({investorId:text.optional(),name,comments:text})
export const ruleSchema = z.object({id:z.enum(['TM-001','TM-002','TM-003','TM-004','TM-005','TM-006','TM-007']),name,description:text,enabled:z.boolean(),locked:z.boolean(),threshold:z.number().finite().nonnegative().optional()}).transform(r=>r.id==='TM-001'?{...r,enabled:true,locked:true,threshold:30000}:{...r,locked:false})
export const reviewSchema = z.object({flagId:name,decision:z.enum(['Pending','Cleared','Request Information','Escalated']),comments:text,reviewedBy:name,reviewedAt:z.iso.datetime(),investorName:text.optional(),investorId:text.optional()})
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const amlReviewSchema = z.object({investorId:name,name,nextReviewDate:isoDate,comments:text,completedBy:name,completedAt:z.iso.datetime()})
export const screeningMatchSchema = z.object({key:name,list:z.enum(['UNSC','MOHA']),investorId:text,investorName:name,entryName:name,entryRef:text,entryDetail:text,score:z.number().min(0).max(1)})
export const screeningDecisionSchema = z.object({key:name,decision:z.enum(['False positive','True match']),comments:text,reviewedBy:name,reviewedAt:z.iso.datetime()})
export const signoffSchema = z.object({month:z.string().regex(/^\d{4}-\d{2}$/),reviewedBy:name,designation:name,comments:text,status:z.enum(['Pending','Completed']),updatedAt:z.iso.datetime()})
export type Signoff = z.infer<typeof signoffSchema>
export function schemaFor(dataset:string) {
  if (/^transactions:\d{4}-(0[1-9]|1[0-2])$/.test(dataset)) return transactionSchema
  if (/^review:.{1,500}$/.test(dataset)) return reviewSchema
  if (/^signoff:\d{4}-(0[1-9]|1[0-2])$/.test(dataset)) return signoffSchema
  if (/^amlreview:.{1,500}$/.test(dataset)) return amlReviewSchema
  if (/^screen:.{1,500}$/.test(dataset)) return screeningDecisionSchema
  return ({staff:staffSchema,history:historySchema,notes:noteSchema,investors:investorSchema,profiles:profileSchema,screening:screeningMatchSchema,context:contextSchema,rules:ruleSchema} as Record<string,z.ZodType>)[dataset]
}
