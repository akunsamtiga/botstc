import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { FirebaseService } from '../firebase/firebase.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private firebaseService: FirebaseService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
    });
  }

  async validate(payload: { sub: string; email: string }) {
    const doc = await this.firebaseService.db
      .collection('sessions')
      .doc(payload.sub)
      .get();
    if (!doc.exists) throw new UnauthorizedException('Session tidak ditemukan, silakan login ulang');
    return { userId: payload.sub, email: payload.email };
  }
}
