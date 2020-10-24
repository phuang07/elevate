import { Component, Inject, OnInit } from "@angular/core";
import { ConfirmDialogDataModel } from "../shared/dialogs/confirm-dialog/confirm-dialog-data.model";
import { ConfirmDialogComponent } from "../shared/dialogs/confirm-dialog/confirm-dialog.component";
import { MatDialog } from "@angular/material/dialog";
import { DesktopSyncService } from "../shared/services/sync/impl/desktop-sync.service";
import { SyncState } from "../shared/services/sync/sync-state.enum";
import { AppRoutesModel } from "../shared/models/app-routes.model";
import { Router } from "@angular/router";
import { ConnectorSyncDateTime } from "@elevate/shared/models/sync/index";
import { ConnectorType } from "@elevate/shared/sync";
import moment from "moment";
import { OPEN_RESOURCE_RESOLVER, OpenResourceResolver } from "../shared/services/links-opener/open-resource-resolver";

@Component({
  selector: "app-connectors",
  templateUrl: "./connectors.component.html",
  styleUrls: ["./connectors.component.scss"]
})
export class ConnectorsComponent implements OnInit {
  public static readonly ATHLETE_CHECKING_FIRST_SYNC_MESSAGE: string = "ATHLETE_CHECKING_FIRST_SYNC";

  public connectorType: ConnectorType;
  public syncDateTime: Date;
  public humanSyncDateTime: string;

  constructor(
    @Inject(DesktopSyncService) protected readonly desktopSyncService: DesktopSyncService,
    @Inject(OPEN_RESOURCE_RESOLVER) protected readonly openResourceResolver: OpenResourceResolver,
    @Inject(Router) protected readonly router: Router,
    @Inject(MatDialog) protected readonly dialog: MatDialog
  ) {
    this.connectorType = null;
    this.syncDateTime = null;
    this.humanSyncDateTime = null;
  }

  public ngOnInit(): void {}

  public updateSyncDateTimeText(): void {
    this.getSyncDateTime().then(connectorSyncDateTime => {
      this.syncDateTime =
        connectorSyncDateTime && connectorSyncDateTime.syncDateTime
          ? new Date(connectorSyncDateTime.syncDateTime)
          : null;
      this.humanSyncDateTime =
        connectorSyncDateTime && connectorSyncDateTime.syncDateTime
          ? "Synced " + moment(connectorSyncDateTime.syncDateTime).fromNow() + "."
          : "Never synced.";
    });
  }

  public sync(fastSync: boolean = null, forceSync: boolean = null): Promise<void> {
    return this.desktopSyncService.getSyncState().then((syncState: SyncState) => {
      if (syncState === SyncState.NOT_SYNCED) {
        const data: ConfirmDialogDataModel = {
          title: "Important: check your athlete settings before",
          content:
            "No activities were synced before. First make sure you have properly configured your dated athlete settings including functional thresholds before. " +
            "A lack of athlete settings configuration can result in empty stats/charts (e.g. flat fitness trend).",
          confirmText: "Sync",
          cancelText: "Configure athlete settings"
        };

        const dialogRef = this.dialog.open(ConfirmDialogComponent, {
          minWidth: ConfirmDialogComponent.MIN_WIDTH,
          maxWidth: "50%",
          data: data
        });

        return dialogRef
          .afterClosed()
          .toPromise()
          .then((confirm: boolean) => {
            const checkAthleteSettings = !confirm;
            if (checkAthleteSettings) {
              this.router.navigate([AppRoutesModel.athleteSettings]);
              return Promise.reject(ConnectorsComponent.ATHLETE_CHECKING_FIRST_SYNC_MESSAGE);
            } else {
              return Promise.resolve();
            }
          });
      } else {
        return Promise.resolve();
      }
    });
  }

  public onOpenLink(url: string): void {
    const data: ConfirmDialogDataModel = {
      title: "Plug your connector on this page as a fitness company or organization",
      content: "Please contact me on twitter to get your fitness company or organization connector in Elevate.",
      confirmText: "Contact me"
    };

    const dialogRef = this.dialog.open(ConfirmDialogComponent, {
      minWidth: ConfirmDialogComponent.MIN_WIDTH,
      maxWidth: ConfirmDialogComponent.MAX_WIDTH,
      data: data
    });

    dialogRef.afterClosed().subscribe((confirm: boolean) => {
      if (confirm) {
        this.openResourceResolver.openLink(url);
      }
    });
  }

  public getSyncDateTime(): Promise<ConnectorSyncDateTime> {
    return this.desktopSyncService.getSyncDateTimeByConnectorType(this.connectorType);
  }
}