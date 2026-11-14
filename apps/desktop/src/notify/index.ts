// The app's NotificationService, created on first use with the platform's sink and the app store.
import { createNotificationSink } from "../native/notifications";
import { focusWindow } from "../native/window";
import { store } from "../store";
import { NotificationService } from "./service";

let service: NotificationService | null = null;

export function notifications(): NotificationService {
  service ??= new NotificationService({
    sink: createNotificationSink(),
    getState: store.getState,
    dispatch: store.dispatch,
    focusWindow,
  });
  return service;
}
