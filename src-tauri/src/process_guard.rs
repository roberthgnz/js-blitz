// The shell plugin creates a process group/job for explicit tree termination.
// This additional Windows job also terminates descendants if the native host
// crashes, before normal shutdown handling can run.
#[cfg(windows)]
mod platform {
    use std::{io, mem, ptr};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
        },
    };

    pub struct ProcessGuard(HANDLE);

    // The owned job handle is used only by thread-safe Win32 operations.
    unsafe impl Send for ProcessGuard {}
    unsafe impl Sync for ProcessGuard {}

    impl ProcessGuard {
        pub fn attach(pid: u32) -> io::Result<Self> {
            let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let guard = Self(handle);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    mem::size_of_val(&limits) as u32,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
            if process.is_null() {
                return Err(io::Error::last_os_error());
            }
            let assigned = unsafe { AssignProcessToJobObject(handle, process) };
            let error = (assigned == 0).then(io::Error::last_os_error);
            unsafe { CloseHandle(process) };
            if let Some(error) = error {
                return Err(error);
            }
            Ok(guard)
        }
    }

    impl Drop for ProcessGuard {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub struct ProcessGuard;

    impl ProcessGuard {
        pub fn attach(_pid: u32) -> std::io::Result<Self> {
            Ok(Self)
        }
    }
}

pub use platform::ProcessGuard;
