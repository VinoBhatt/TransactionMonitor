export type Role = 'admin' | 'compliance' | 'chief_compliance'
export type User = {id:string,username:string,displayName:string,role:Role,mustChangePassword:boolean}
export const roleLabels:Record<Role,string> = {admin:'Admin',compliance:'Compliance Officer',chief_compliance:'Chief Compliance Officer'}
export function canWrite(role:Role,dataset:string) {
  if(dataset==='rules'||dataset.startsWith('signoff:'))return role==='admin'||role==='chief_compliance'
  return true
}
