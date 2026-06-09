import { mount } from "svelte";
import App from "./App.svelte";
import "./lib/design/tokens.css";

const app = mount(App, { target: document.getElementById("app")! });

export default app;
