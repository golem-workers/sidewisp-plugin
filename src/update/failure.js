// Only these local helper causes may cross the control-plane boundary. Never
// forward arbitrary exception text, command output, paths or provider details.
const CODES=new Set(['TARGET_COLLECTOR_UNHEALTHY','BINDING_CHANGED','NEWER_PACKAGE_INSTALLED','ARTIFACT_HASH_MISMATCH','ARTIFACT_DOWNLOAD_FAILED','INSTALLED_PACKAGE_UNAVAILABLE','INVALID_RECOVERY_CHECKPOINT','RECOVERY_BASELINE_REQUIRED','INVALID_ARCHIVE_PATH']);
export function safeUpdateFailure(error){
 if(CODES.has(error?.message))return error.message;
 if(error?.message==='managed_active_profile_required')return 'HOST_PROFILE_UNVERIFIED';
 if(error?.message==='host_activation_not_prepared')return 'HOST_ACTIVATION_NOT_PREPARED';
 return 'INSTALL_OR_RELOAD_REFUSED';
}
