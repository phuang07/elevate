import { Inject, Injectable, OnDestroy } from "@angular/core";
import { SyncService } from "../sync.service";
import { VERSIONS_PROVIDER, VersionsProvider } from "../../versions/versions-provider.interface";
import { AthleteService } from "../../athlete/athlete.service";
import { UserSettingsService } from "../../user-settings/user-settings.service";
import { LoggerService } from "../../logging/logger.service";
import { Subject, Subscription } from "rxjs";
import { ActivitySyncEvent, ConnectorType, ErrorSyncEvent, StravaApiCredentials, SyncEvent, SyncEventType } from "@elevate/shared/sync";
import { IpcRendererMessagesService } from "../../messages-listener/ipc-renderer-messages.service";
import { FlaggedIpcMessage, MessageFlag } from "@elevate/shared/electron";
import { StravaApiCredentialsService } from "../../strava-api-credentials/strava-api-credentials.service";
import { AthleteModel, SyncedActivityModel, UserSettings } from "@elevate/shared/models";
import { ActivityService } from "../../activity/activity.service";
import { ElevateException, SyncException } from "@elevate/shared/exceptions";
import { isArray, isString } from "util";
import * as _ from "lodash";
import { SyncState } from "../sync-state.enum";
import { DesktopDataStore } from "../../../data-store/impl/desktop-data-store.service";
import { DataStore } from "../../../data-store/data-store";
import * as moment from "moment";
import { ConnectorLastSyncDateTime } from "../../../../../../modules/shared/models/sync/connector-last-sync-date-time.model";
import { ConnectorLastSyncDateTimeDao } from "../../../dao/sync/connector-last-sync-date-time.dao";
import { DesktopDumpModel } from "../../../models/dumps/desktop-dump.model";
import UserSettingsModel = UserSettings.UserSettingsModel;

// TODO Handle sync complete
// TODO Add sync gen session id as string baseConnector. Goal: more easy to debug sync session with start/stop actions?
// TODO Handle errors cases (continue or not the sync...)
// TODO Provide a sync view with all sync events tracked (tmp saved?!) & displayed => to sum up a sync log view.
// TODO Sync ribbon displayed on startup? Allow user to see the sync log view
/* TODO Handle connector priority?! Consider not syncing all connector
    but allow user to mark a connector as "Primary" which will be synced when starting the app.
	Also allow user to sync connector he wants manually on connectors page
 */

// TODO "version" of dump should compared to "the current code version".

// TODO Handle no strava access token (or expired) when starting strava sync
// TODO Handle updateSyncedActivitiesNameAndType of strava over filesystem connector

// TODO Forward toolbar sync button to Connectors
// TODO Move "last sync date time" to  StravaApiCredentials storage key

// TODO Test in a current sync is running on Service.currentConnector(setter)
// tslint:disable-next-line:max-line-length
// TODO Add unit add with try/catch on StravaConnector.prepareBareActivity() call ?! => 'bareActivity = this.prepareBareActivity(bareActivity);'
// TODO Strava dont give "calories" from "getStravaBareActivityModels" bare activities. Only "kilojoules"! We have to get calories...

@Injectable()
export class DesktopSyncService extends SyncService<ConnectorLastSyncDateTime[]> implements OnDestroy {

	constructor(@Inject(VERSIONS_PROVIDER) public versionsProvider: VersionsProvider,
				public activityService: ActivityService,
				public athleteService: AthleteService,
				public userSettingsService: UserSettingsService,
				public messageListenerService: IpcRendererMessagesService,
				public stravaApiCredentialsService: StravaApiCredentialsService,
				public logger: LoggerService,
				public connectorLastSyncDateTimeDao: ConnectorLastSyncDateTimeDao,
				@Inject(DataStore) public desktopDataStore: DesktopDataStore<void> /* Injected to create PouchDB dumps & load them */) {
		super(versionsProvider, activityService, athleteService, userSettingsService, logger);
		this.syncSubscription = null;
		this.syncEvents$ = new Subject<SyncEvent>(); // Starting new sync // TODO ReplaySubject?! I think no
		this.currentConnectorType = null;
	}

	public syncEvents$: Subject<SyncEvent>;
	public syncSubscription: Subscription;
	public currentConnectorType: ConnectorType;

	public static transformErrorToSyncException(error: Error | Error[] | string | string[]): SyncException {

		if (error instanceof SyncException) {
			return error;
		} else if (error instanceof Error) {
			return SyncException.fromError(error);
		} else if (isString(error)) {
			return new SyncException(error);
		} else {
			return new SyncException(JSON.stringify(error));
		}
	}

	/**
	 *
	 * @param fastSync
	 * @param forceSync
	 * @param connectorType
	 * @return Subject<SyncEvent>
	 */
	public sync(fastSync: boolean, forceSync: boolean, connectorType: ConnectorType = null): Promise<void> {

		if (!connectorType) {
			throw new SyncException("ConnectorType param must be given");
		}

		this.currentConnectorType = connectorType;

		this.messageListenerService.listen();

		const promisedDataToSync: Promise<any>[] = [
			this.athleteService.fetch(),
			this.userSettingsService.fetch()
		];

		if (this.currentConnectorType === ConnectorType.STRAVA) {

			promisedDataToSync.push(this.stravaApiCredentialsService.fetch());

		} else {
			const errorMessage = "Unknown connector type to sync";
			this.logger.error(errorMessage);
			throw new SyncException(errorMessage);
		}

		if (this.syncSubscription) {
			this.syncSubscription.unsubscribe();
		}

		// Subscribe for sync events
		this.syncSubscription = this.messageListenerService.syncEvents$.subscribe((syncEvent: SyncEvent) => {
			this.handleSyncEvents(this.syncEvents$, syncEvent);
		});

		return Promise.all(promisedDataToSync).then(result => {

			const athleteModel: AthleteModel = <AthleteModel> result[0];
			const userSettingsModel: UserSettingsModel = <UserSettingsModel> result[1];

			let startSyncMessage: FlaggedIpcMessage;

			if (this.currentConnectorType === ConnectorType.STRAVA) {

				const stravaApiCredentials: StravaApiCredentials = <StravaApiCredentials> result[2];

				// Create message to start sync on connector!
				const updateSyncedActivitiesNameAndType = true;
				startSyncMessage = new FlaggedIpcMessage(MessageFlag.START_SYNC, ConnectorType.STRAVA, stravaApiCredentials, athleteModel,
					updateSyncedActivitiesNameAndType, userSettingsModel);

			}

			// Trigger sync start
			return this.messageListenerService.send<string>(startSyncMessage).then((response: string) => {
				this.logger.info("Message received by ipcMain. Response:", response);
				return Promise.resolve();
			}, error => {
				// e.g. Impossible to start a new sync. Another sync is already running on connector ...
				this.logger.error(error);
				return Promise.reject(error);
			});
		});
	}

	public handleSyncEvents(syncEvents$: Subject<SyncEvent>, syncEvent: SyncEvent): void {

		switch (syncEvent.type) {

			case SyncEventType.STARTED:
				syncEvents$.next(syncEvent); // Forward for upward UI use.
				this.logger.info(syncEvent);
				break;

			case SyncEventType.ACTIVITY:
				this.handleActivityUpsert(syncEvents$, <ActivitySyncEvent> syncEvent);
				break;

			case SyncEventType.STOPPED:
				syncEvents$.next(syncEvent); // Forward for upward UI use.
				this.logger.info(syncEvent);
				break;

			case SyncEventType.GENERIC:
				syncEvents$.next(syncEvent); // Forward for upward UI use.
				this.logger.debug(syncEvent);
				break;

			case SyncEventType.COMPLETE:
				syncEvents$.next(syncEvent); // Forward for upward UI use.
				this.logger.info(syncEvent);
				break;

			case SyncEventType.ERROR:
				this.handleErrorSyncEvents(syncEvents$, <ErrorSyncEvent> syncEvent);
				break;

			default:
				const errorMessage = "Unknown sync event type: " + JSON.stringify(syncEvent);
				this.logger.error(errorMessage);
				this.throwSyncError(new SyncException(errorMessage));
		}

	}

	public handleErrorSyncEvents(syncEvents$: Subject<SyncEvent>, errorSyncEvent: ErrorSyncEvent): void {

		this.logger.error(errorSyncEvent);

		if (!errorSyncEvent.code) {
			this.throwSyncError(new SyncException(errorSyncEvent.toString()));
			return;
		}

		if (errorSyncEvent.code === ErrorSyncEvent.SYNC_ERROR_COMPUTE.code
			|| errorSyncEvent.code === ErrorSyncEvent.UNHANDLED_ERROR_SYNC.code
			|| errorSyncEvent.code === ErrorSyncEvent.SYNC_ERROR_UPSERT_ACTIVITY_DATABASE.code
			|| errorSyncEvent.code === ErrorSyncEvent.STRAVA_API_UNAUTHORIZED.code
			|| errorSyncEvent.code === ErrorSyncEvent.STRAVA_API_FORBIDDEN.code
			|| errorSyncEvent.code === ErrorSyncEvent.STRAVA_INSTANT_QUOTA_REACHED.code
			|| errorSyncEvent.code === ErrorSyncEvent.STRAVA_DAILY_QUOTA_REACHED.code
		) {

			syncEvents$.next(errorSyncEvent); // Forward for upward UI use.

			// Stop sync !!
			this.stop().catch(stopError => {
				this.throwSyncError(stopError); // Should be caught by Error Handler
			});

		} else if (errorSyncEvent.code === ErrorSyncEvent.MULTIPLE_ACTIVITIES_FOUND.code
			|| errorSyncEvent.code === ErrorSyncEvent.SYNC_ALREADY_STARTED.code
			|| errorSyncEvent.code === ErrorSyncEvent.STRAVA_API_RESOURCE_NOT_FOUND.code
			|| errorSyncEvent.code === ErrorSyncEvent.STRAVA_API_TIMEOUT.code
		) {

			syncEvents$.next(errorSyncEvent); // Forward for upward UI use.

		} else {
			const syncException = new SyncException("Unknown ErrorSyncEvent", errorSyncEvent);
			this.throwSyncError(syncException);
		}

	}

	public stop(): Promise<void> {

		this.logger.info(`Stop sync requested on connector ${this.currentConnectorType}`);

		return new Promise((resolve, reject) => {

			if (this.currentConnectorType === null) {
				reject();
				return;
			}

			const stopSyncMessage = new FlaggedIpcMessage(MessageFlag.STOP_SYNC, this.currentConnectorType);

			this.messageListenerService.send<string>(stopSyncMessage).then((response: string) => {
				this.logger.info("Sync stopped. Response from main:", response);
				resolve();
			}, error => {
				const errorMessage =
					`Unable to stop sync on connector: ${this.currentConnectorType}. Connector replied with ${JSON.stringify(error)}`;
				this.logger.error(errorMessage);
				reject(errorMessage);
			});
		});
	}

	public handleActivityUpsert(syncEvents$: Subject<SyncEvent>, activitySyncEvent: ActivitySyncEvent): void {

		const errors = [];

		// Insert new activity or update an existing one to database
		this.logger.info(`Trying to upsert activity "${activitySyncEvent.activity.name}" started on "${activitySyncEvent.activity.start_time}".`);

		this.activityService.put(activitySyncEvent.activity).then((syncedActivityModel: SyncedActivityModel) => {

			this.logger.info(`Activity "${syncedActivityModel.name}" saved`);
			syncEvents$.next(activitySyncEvent); // Forward for upward UI use.

		}).catch((upsertError: Error) => {

			this.logger.error(upsertError);

			const stopSyncPromise = this.stop();

			syncEvents$.next(ErrorSyncEvent.SYNC_ERROR_UPSERT_ACTIVITY_DATABASE.create(ConnectorType.STRAVA,
				activitySyncEvent.activity, upsertError.stack));

			errors.push(upsertError);

			// Trigger sync stop
			return stopSyncPromise;

		}).then(() => {

			// Stopped properly, throw the upsert error
			if (errors.length > 0) {
				this.throwSyncError(errors); // Should be caught by Error Handler
			}

		}, stopError => {
			this.logger.error(stopError);
			errors.push(stopError);
			this.throwSyncError(errors); // Should be caught by Error Handler
		});

	}

	public throwSyncError(error: Error | Error[] | string | string[]): void {

		if (isArray(error)) {

			const syncExceptions = [];
			_.forEach(error, err => {
				const syncException = DesktopSyncService.transformErrorToSyncException(<any> err);
				syncExceptions.push(syncException);
			});

			throw syncExceptions;

		} else {
			throw DesktopSyncService.transformErrorToSyncException(<Error | Error[] | string | string[]> error);
		}

	}

	public export(): Promise<{ filename: string; size: number }> {
		return this.desktopDataStore.createDump().then(blob => {
			return this.versionsProvider.getInstalledAppVersion().then(appVersion => {
				const gzippedFilename = moment().format("Y.MM.DD-H.mm") + "_v" + appVersion + ".elevate";
				this.saveAs(blob, gzippedFilename);
				return Promise.resolve({filename: gzippedFilename, size: blob.size});
			});
		});
	}

	public import(desktopDumpModel: DesktopDumpModel): Promise<void> {
		return this.desktopDataStore.loadDump(desktopDumpModel);
	}

	public getSyncState(): Promise<SyncState> {

		return Promise.all([

			this.getLastSyncDateTime(),
			this.activityService.fetch()

		]).then((result: Object[]) => {

			const connectorLastSyncDateTimes: ConnectorLastSyncDateTime[] = result[0] as ConnectorLastSyncDateTime[];
			const syncedActivityModels: SyncedActivityModel[] = result[1] as SyncedActivityModel[];

			const hasALastSyncDateTime: boolean = (connectorLastSyncDateTimes.length > 0);
			const hasSyncedActivityModels: boolean = !_.isEmpty(syncedActivityModels);

			let syncState: SyncState = null;
			if (!hasALastSyncDateTime && !hasSyncedActivityModels) {
				syncState = SyncState.NOT_SYNCED;
			} else if (!hasALastSyncDateTime && hasSyncedActivityModels) {
				syncState = SyncState.PARTIALLY_SYNCED;
			} else {
				syncState = SyncState.SYNCED;
			}

			return Promise.resolve(syncState);
		});

	}

	public getLastSyncDateTime(): Promise<ConnectorLastSyncDateTime[]> {
		return <Promise<ConnectorLastSyncDateTime[]>> this.connectorLastSyncDateTimeDao.fetch();
	}

	public upsertLastSyncDateTimes(connectorLastSyncDateTimes: ConnectorLastSyncDateTime[]): Promise<ConnectorLastSyncDateTime[]> {


		if (!_.isArray(connectorLastSyncDateTimes)) {
			throw new Error("connectorLastSyncDateTimes param must be an array");
		}

		const putPromises = [];
		_.forEach(connectorLastSyncDateTimes, (connectorLastSyncDateTime: ConnectorLastSyncDateTime) => {
			putPromises.push(this.connectorLastSyncDateTimeDao.put(connectorLastSyncDateTime));
		});

		return Promise.all(putPromises).then(() => {
			return <Promise<ConnectorLastSyncDateTime[]>> this.connectorLastSyncDateTimeDao.fetch();
		});
	}

	public saveLastSyncDateTime(connectorLastSyncDateTimes: ConnectorLastSyncDateTime[]): Promise<ConnectorLastSyncDateTime[]> {
		throw new ElevateException("Please use upsertLastSyncDateTimes() method when using DesktopSyncService");
	}

	public clearLastSyncTime(): Promise<void> {
		return this.connectorLastSyncDateTimeDao.clear();
	}


	public ngOnDestroy(): void {
		if (this.syncSubscription) {
			this.syncSubscription.unsubscribe();
		}
	}
}
