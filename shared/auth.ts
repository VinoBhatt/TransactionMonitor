export type Role = 'admin' | 'compliance' | 'chief_compliance'
export type User = {id:string,username:string,displayName:string,role:Role,mustChangePassword:boolean}
export type ManagedUser = User & {active:boolean,createdAt:string,passwordChangedAt:string|null}
export type AuditEvent = {id:number,dataset:string,action:string,createdAt:string,userId:string|null,displayName:string|null,username:string|null}
export const roleLabels:Record<Role,string> = {admin:'Admin',compliance:'Compliance Officer',chief_compliance:'Chief Compliance Officer'}
export const canViewAudit = (role:Role) => role==='admin'||role==='chief_compliance'
export function canWrite(role:Role,dataset:string) {
  if(dataset==='notifications')return role==='admin'
  if(dataset==='rules'||dataset.startsWith('signoff:'))return role==='admin'||role==='chief_compliance'
  return true
}
