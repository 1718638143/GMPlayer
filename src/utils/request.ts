import axios, {
  AxiosRequestConfig,
  AxiosResponse,
  AxiosError,
  InternalAxiosRequestConfig,
  AxiosHeaders,
} from "axios";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isMobileDevice } from "@/utils/tauri/mobile";
import { isTauri } from "@/utils/tauri/windowManager";

// Extend AxiosRequestConfig to include custom hiddenBar property
export interface CustomAxiosRequestConfig extends AxiosRequestConfig {
  hiddenBar?: boolean;
}

// Extend InternalAxiosRequestConfig for interceptor use
interface CustomInternalAxiosRequestConfig extends InternalAxiosRequestConfig {
  hiddenBar?: boolean;
}

// Global $loadingBar type is declared in src/types/globals.d.ts

let baseURL = "";

// Use Vite's environment detection
if (import.meta.env.PROD) {
  baseURL = import.meta.env.VITE_MUSIC_API as string;
} else {
  baseURL = "/api/ncm";
}

axios.defaults.baseURL = baseURL;
axios.defaults.timeout = 30000;
axios.defaults.headers.common["X-Requested-With"] = "XMLHttpRequest";
axios.defaults.withCredentials = true;

// Android/iOS WebViews enforce browser CORS for production API requests. Use
// Tauri's native HTTP transport on mobile builds so login and its cookie jar
// stay on the same transport. Development keeps using Vite's same-origin proxy.
const useNativeMobileHttp =
  import.meta.env.PROD && typeof window !== "undefined" && isTauri() && isMobileDevice();

if (useNativeMobileHttp) {
  axios.defaults.adapter = "fetch";
  axios.defaults.env = {
    ...axios.defaults.env,
    fetch: tauriFetch,
  };
}

// 请求拦截
axios.interceptors.request.use(
  (request: CustomInternalAxiosRequestConfig) => {
    // Ensure headers object exists
    if (!request.headers) {
      request.headers = new AxiosHeaders();
    }

    // 确保使用默认的 baseURL
    request.baseURL = baseURL;
    // 确保凭据设置为 true
    request.withCredentials = true;
    // 确保 X-Requested-With 请求头存在
    if (!request.headers.has("X-Requested-With")) {
      request.headers.set("X-Requested-With", "XMLHttpRequest");
    }

    if (!request.hiddenBar && typeof $loadingBar !== "undefined") $loadingBar.start();
    return request;
  },
  (error: AxiosError) => {
    if (typeof $loadingBar !== "undefined") $loadingBar.error();
    console.error("请求失败，请稍后重试");
    return Promise.reject(error);
  },
);

// 响应拦截
axios.interceptors.response.use(
  (response: AxiosResponse) => {
    if (typeof $loadingBar !== "undefined") $loadingBar.finish();
    return response.data;
  },
  (error: AxiosError) => {
    if (typeof $loadingBar !== "undefined") $loadingBar.error();
    if (error.response) {
      const data = error.response.data as { message?: string };
      switch (error.response.status) {
        case 401:
          console.error(data.message ? data.message : "无权限访问");
          break;
        case 301:
          console.error(data.message ? data.message : "请求发生重定向");
          break;
        case 404:
          console.error(data.message ? data.message : "请求资源不存在");
          break;
        case 500:
          console.error(data.message ? data.message : "内部服务器错误");
          break;
        default:
          console.error(data.message ? data.message : "请求失败，请稍后重试");
          break;
      }
    } else {
      console.error("请求失败，请稍后重试");
    }
    return Promise.reject(error);
  },
);

// Create a typed request function
function request<T = any>(config: CustomAxiosRequestConfig): Promise<T> {
  return axios(config) as Promise<T>;
}

export { request };
export default request;
