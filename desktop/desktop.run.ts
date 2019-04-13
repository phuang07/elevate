import * as Electron from "electron";
import { app, BrowserWindow, globalShortcut } from "electron";
import * as path from "path";
import * as url from "url";
import logger from "electron-log";

logger.transports.file.maxSize = 1048576; // 1MB

class DesktopRun {

	private static readonly WINDOW_WIDTH: number = 1600;
	private static readonly WINDOW_HEIGHT: number = 1024;

	private readonly app: Electron.App;
	private readonly isPackaged: boolean;
	private appWindow: BrowserWindow;

	constructor(app: Electron.App) {
		this.app = app;
		this.isPackaged = this.app.isPackaged;
	}

	public createWindow(): void {

		// Create the browser window.
		const winWidth = DesktopRun.WINDOW_WIDTH;
		const winHeight = DesktopRun.WINDOW_HEIGHT;

		this.appWindow = new BrowserWindow({
			width: winWidth,
			height: winHeight,
			center: true,
			frame: true
		});

		this.appWindow.loadURL(
			url.format({
				pathname: path.join(__dirname, "app", "index.html"),
				protocol: "file:",
				slashes: true,
			}),
		);

		if (!this.isPackaged) {
			this.appWindow.webContents.openDevTools();
		}

		// Emitted when the window is closed.
		this.appWindow.on("closed", () => {
			// Dereference the window object, usually you would store window
			// in an array if your app supports multi windows, this is the time
			// when you should delete the corresponding element.
			this.appWindow = null;
		});

		// Shortcuts
		globalShortcut.register("f5", () => {
			logger.log("f5 is pressed, reload app");
			this.appWindow.reload();
		});

		globalShortcut.register("CommandOrControl+R", () => {
			logger.log("CommandOrControl+R is pressed, reload app");
			this.appWindow.reload();
		});

		globalShortcut.register("CommandOrControl+F12", () => {
			logger.log("CommandOrControl+F12 is pressed, toggle dev tools");
			this.appWindow.webContents.toggleDevTools();
		});

	}

	public run(): void {

		if (this.isPackaged) {
			logger.log("Running in production");
		} else {
			logger.log("Running in development");
		}

		logger.log("App running into: " + this.app.getAppPath());

		// This method will be called when Electron has finished
		// initialization and is ready to create browser windows.
		// Some APIs can only be used after this event occurs.
		this.app.on("ready", this.createWindow);

		// Quit when all windows are closed.
		this.app.on("window-all-closed", () => {
			// On OS X it is common for this.applications and their menu bar
			// to stay active until the user quits explicitly with Cmd + Q
			if (process.platform !== "darwin") {
				this.app.quit();
			}
		});

		this.app.on("activate", () => {
			// On OS X it"s common to re-create a window in the app when the
			// dock icon is clicked and there are no other windows open.
			if (!this.appWindow) {
				this.createWindow();
			}
		});
	}
}

try {
	require("electron-reloader")(module);
	(new DesktopRun(app)).run();
} catch (err) {
	logger.error(err);
}