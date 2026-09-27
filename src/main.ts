import { openFightStore } from "./api/cache.ts";
import { startApp } from "./ui/app.ts";
import "./style.css";

const { store, persistent } = await openFightStore();
startApp(document.getElementById("app")!, store, persistent);
