export type Dataset = {name:string,version:string,source:string,updated_at:string}
export class ApiError extends Error { constructor(public status:number,message:string){super(message)} }
export async function request<T>(path:string,method='GET',body?:unknown):Promise<T> {
  const response=await fetch(`/api${path}`,{method,credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})
  const data=await response.json()
  if(!response.ok)throw new ApiError(response.status,data.error||'Request failed.')
  return data
}
export async function readDataset<T>(dataset:Dataset):Promise<T[]> {
  const rows:T[]=[]
  for(let offset=0;;offset+=500){
    const page=await request<T[]>(`/records?dataset=${encodeURIComponent(dataset.name)}&version=${dataset.version}&offset=${offset}`)
    rows.push(...page)
    if(page.length<500)return rows
  }
}
export async function writeDataset(dataset:string,version:string,items:unknown[],source='') {
  const {id}=await request<{id:string}>('/imports','POST',{dataset,version,source,count:items.length})
  for(let offset=0;offset<items.length;){
    const chunk:unknown[]=[];let bytes=0
    while(offset+chunk.length<items.length && chunk.length<250){
      const item=items[offset+chunk.length],size=new TextEncoder().encode(JSON.stringify(item)).length
      if(size>800000)throw new Error('One record is too large to save. Please reduce its content.')
      if(bytes+size>800000)break
      bytes+=size+1;chunk.push(item)
    }
    await request(`/imports/${id}`,'PUT',{offset,items:chunk})
    offset+=chunk.length
  }
  return request<{version:string}>(`/imports/${id}/commit`,'POST',{})
}
