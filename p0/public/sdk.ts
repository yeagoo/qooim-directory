// Trusted composition boundary: injection keeps templates away from the database.
export interface PublicItem {slug:string;title:string;locale:string}
export interface TemplateData {name:string;items:readonly PublicItem[]}
// This reviewed gateway is the only public-layer composition exception.
export {publicResponse} from '../internal/http.js';
