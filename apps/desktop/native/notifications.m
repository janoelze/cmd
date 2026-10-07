// Whether macOS lets cmd show notifications, and asking it to (Settings →
// Notifications, src/main/notify-permission.ts). A Node-API addon, not a helper
// process like sfsymbols: macOS answers for the app that asks, so this runs in
// Electron main. Built by scripts/postinstall.mjs with plain clang; Node-API is
// a stable C ABI, so the few functions used are declared here instead of
// needing Node's or Electron's headers.
//
// status(cb) and request(cb) call cb once with a JSON string:
// {"authorization":"notDetermined|denied|authorized|provisional",
//  "alerts":bool, "style":"none|banner|alert", "bundleId":"…"}

#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <stdint.h>

typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef struct napi_callback_info__* napi_callback_info;
typedef struct napi_threadsafe_function__* napi_threadsafe_function;
typedef int napi_status;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
typedef void (*napi_finalize)(napi_env, void*, void*);
typedef void (*napi_threadsafe_function_call_js)(napi_env, napi_value, void*, void*);
enum { napi_tsfn_release = 0 };
enum { napi_tsfn_blocking = 1 };

extern napi_status napi_create_function(napi_env, const char*, size_t, napi_callback, void*, napi_value*);
extern napi_status napi_set_named_property(napi_env, napi_value, const char*, napi_value);
extern napi_status napi_get_cb_info(napi_env, napi_callback_info, size_t*, napi_value*, napi_value*, void**);
extern napi_status napi_create_string_utf8(napi_env, const char*, size_t, napi_value*);
extern napi_status napi_get_undefined(napi_env, napi_value*);
extern napi_status napi_call_function(napi_env, napi_value, napi_value, size_t, const napi_value*, napi_value*);
extern napi_status napi_create_threadsafe_function(napi_env, napi_value, napi_value, napi_value, size_t, size_t, void*, napi_finalize, void*,
                                                   napi_threadsafe_function_call_js, napi_threadsafe_function*);
extern napi_status napi_call_threadsafe_function(napi_threadsafe_function, void*, int);
extern napi_status napi_release_threadsafe_function(napi_threadsafe_function, int);

static const char* authorization(UNAuthorizationStatus s) {
  switch (s) {
    case UNAuthorizationStatusDenied: return "denied";
    case UNAuthorizationStatusAuthorized: return "authorized";
    case UNAuthorizationStatusProvisional: return "provisional";
    default: return "notDetermined";
  }
}

static const char* style(UNAlertStyle s) {
  switch (s) {
    case UNAlertStyleBanner: return "banner";
    case UNAlertStyleAlert: return "alert";
    default: return "none";
  }
}

// On the JS thread: hand the JSON (strdup'd on the macOS side) to the callback.
static void callJs(napi_env env, napi_value cb, void* context, void* data) {
  char* json = data;
  if (env && cb) {
    napi_value arg, recv;
    napi_create_string_utf8(env, json, SIZE_MAX, &arg);
    napi_get_undefined(env, &recv);
    napi_call_function(env, recv, cb, 1, &arg, NULL);
  }
  free(json);
}

/** A threadsafe function for the callback that is the call's first argument, or NULL. */
static napi_threadsafe_function callbackOf(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value cb = NULL, name;
  napi_get_cb_info(env, info, &argc, &cb, NULL, NULL);
  if (argc < 1 || !cb) return NULL;
  napi_create_string_utf8(env, "notifications", SIZE_MAX, &name);
  napi_threadsafe_function tsfn = NULL;
  if (napi_create_threadsafe_function(env, cb, NULL, name, 0, 1, NULL, NULL, NULL, callJs, &tsfn) != 0) return NULL;
  return tsfn;
}

static void reply(napi_threadsafe_function tsfn) {
  [[UNUserNotificationCenter currentNotificationCenter] getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* s) {
    NSString* bundleId = [[NSBundle mainBundle] bundleIdentifier] ?: @"";
    NSDictionary* o = @{
      @"authorization": @(authorization(s.authorizationStatus)),
      @"alerts": s.alertSetting == UNNotificationSettingEnabled ? @YES : @NO,
      @"style": @(style(s.alertStyle)),
      @"bundleId": bundleId,
    };
    NSData* data = [NSJSONSerialization dataWithJSONObject:o options:0 error:NULL];
    NSString* json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    napi_call_threadsafe_function(tsfn, strdup(json.UTF8String), napi_tsfn_blocking);
    napi_release_threadsafe_function(tsfn, napi_tsfn_release);
  }];
}

static napi_value status(napi_env env, napi_callback_info info) {
  napi_threadsafe_function tsfn = callbackOf(env, info);
  if (tsfn) reply(tsfn);
  return NULL;
}

// Shows macOS's "Allow notifications?" prompt if the user hasn't answered it yet
// (otherwise it returns at once), then replies with the status.
static napi_value request(napi_env env, napi_callback_info info) {
  napi_threadsafe_function tsfn = callbackOf(env, info);
  if (!tsfn) return NULL;
  UNAuthorizationOptions opts = UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge;
  [[UNUserNotificationCenter currentNotificationCenter] requestAuthorizationWithOptions:opts
                                                                      completionHandler:^(BOOL granted, NSError* error) { reply(tsfn); }];
  return NULL;
}

__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "status", SIZE_MAX, status, NULL, &fn);
  napi_set_named_property(env, exports, "status", fn);
  napi_create_function(env, "request", SIZE_MAX, request, NULL, &fn);
  napi_set_named_property(env, exports, "request", fn);
  return exports;
}
