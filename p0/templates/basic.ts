import type {TemplateData} from '../public/sdk.js';
export function labels(data:TemplateData) {return data.items.map(item=>item.title);}
