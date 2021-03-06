import { MTProto, getSRPParams } from '@mtproto/core';

import { log, prompt } from './utils/log';

import type {
    CallApiFn,
    CheckPassword,
    GetFullUser,
    GetPassword,
    ICallError,
    SendCode,
    SignIn,
    UpdateProfile,
    UserUnion,
} from './types';

const {
    IS_DEV,
    TELEGRAM_API_ID,
    TELEGRAM_API_HASH,
    TELEGRAM_DEFAULT_BIO,
} = process.env;

export class TelegramClient {
    private api: MTProto;

    constructor() {
        this.api = new MTProto({
            api_id: parseInt(TELEGRAM_API_ID),
            api_hash: TELEGRAM_API_HASH,
        });
    }

    // Auth

    /**
     * @todo rewrite this shit. Auth needs only auth key not found
     *
     * !! Implemented only for valid data !!
     *
     * !! Implemented only for password (2FA password) !!
     */
    public authorization = async (): Promise<UserUnion> => {
        let user: UserUnion | undefined;

        try {
            const userFull = await this.getFullUser();
            user = userFull.user;
        } catch (userError) {
            if (userError.error_message !== 'AUTH_KEY_UNREGISTERED') {
                throw userError;
            }
            log('Authorization needed');

            const phone = await prompt('Please, enter your phone number', 'Required phone number');
            const sendCodeResult = await this.sendCode({ phone_number: phone });

            try {
                const code = await prompt('Please enter the secret code', 'Required secret code');
                const signInResult = await this.signIn({
                    phone_code: code,
                    phone_number: phone,
                    phone_code_hash: sendCodeResult.phone_code_hash,
                });
                user = signInResult.user;
            } catch (signInError) {
                if (signInError.error_message !== 'SESSION_PASSWORD_NEEDED') {
                    throw signInError;
                }
                // eslint-disable-next-line @typescript-eslint/naming-convention
                const { srp_B, srp_id, current_algo } = await this.getPassword();
                const {
                    g, p, salt1, salt2,
                } = current_algo;

                const password = await prompt('Please enter user password', 'Required user password');

                const { A, M1 } = await getSRPParams({
                    g, p, salt1, salt2, gB: srp_B, password,
                });

                const authInfo = await this.checkPassword({ srp_id, A, M1 });
                user = authInfo.user;
            }
        }

        if (user === undefined || user._ === 'userEmpty') {
            log('User not registered. Telegram module skiped');
        } else {
            log(`Authorized on: ${user.username}`);
        }

        return user;
    };

    // Account

    public updateProfile: UpdateProfile = (params) => this.call('account.updateProfile', {
        about: TELEGRAM_DEFAULT_BIO,
        ...params,
    });

    // Users

    public getFullUser: GetFullUser = (params) => this.call('users.getFullUser', {
        id: {
            _: 'inputUserSelf',
            ...params,
        },
    });

    // private Auth

    private sendCode: SendCode = (params) => this.call('auth.sendCode', {
        settings: { _: 'codeSettings' },
        ...params,
    });

    private signIn: SignIn = (params) => this.call('auth.signIn', params);

    private getPassword: GetPassword = () => this.call('account.getPassword');

    private checkPassword: CheckPassword = (params) => this.call('auth.checkPassword', {
        password: {
            _: 'inputCheckPasswordSRP',
            ...params,
        },
    });

    // call api

    private call: CallApiFn = async (method, params, options) => (this.api
        .call(method, params as object, { syncAuth: true, ...options }) as Promise<any>)
        .catch(async (error: ICallError) => {
            if (IS_DEV === 'true') {
                // eslint-disable-next-line no-console
                console.warn(`call ${method} error:`, error);
            }
            // eslint-disable-next-line @typescript-eslint/naming-convention
            const { error_code, error_message } = error;

            let needReCall = false;

            switch (error_code) {
                case 303: {
                    const [type, dcId] = error_message.split('_MIGRATE_');

                    if (type === 'PHONE') {
                        await this.api.setDefaultDc(+dcId);
                    } else {
                        // eslint-disable-next-line no-param-reassign
                        options = {
                            ...options,
                            dcId: +dcId,
                        };
                    }
                    needReCall = true;
                    break;
                }
                case 500: {
                    switch (error_message) {
                        case 'AUTH_RESTART': needReCall = true; break;
                        default: break;
                    }
                    break;
                }
                default: break;
            }

            return needReCall
                ? this.call(method, params, options)
                : Promise.reject(error);
        }) as Promise<any>;
}
